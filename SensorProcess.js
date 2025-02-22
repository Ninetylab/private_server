// lib/SensorProcess.js

const fs = require('fs');
const path = require('path');
const LogManager = require('./LogManager');

// Import the thermal combiner functions
const { combineThermalData, transformCombinedToHeatmapData } = require('./ThermalCombiner');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR);
}

// Nombre de valeurs en FIFO pour le smoothing
const BUFFER_SIZE = 10;
const sensorBuffers = {
    temperature: [],
    humidity: [],
    co2: [],
    thermal: []
};

/**
 * Global store for the latest processed AMG8833 readings for ESP32_1 (left) and ESP32_2 (right).
 * Each entry will be an object with:
 *   - raw: the original 8×8 array
 *   - avg: the computed average temperature from that array
 */
const thermalReadings = {
    '/dev/esp32_1': null, // left sensor
    '/dev/esp32_2': null  // right sensor
};

/**
 * Helper: Processes an AMG8833 8x8 reading only once.
 * Computes the average temperature while preserving the raw array.
 *
 * @param {number[][]} matrix - The 8x8 thermal data.
 * @returns {object|null} An object { raw, avg } or null if input is invalid.
 */
function processAMG8833Reading(matrix) {
    if (!Array.isArray(matrix) || matrix.length !== 8) {
        console.error('AMG8833 reading must be an 8x8 array.');
        return null;
    }
    let sum = 0, count = 0;
    for (let i = 0; i < matrix.length; i++) {
        if (!Array.isArray(matrix[i]) || matrix[i].length !== 8) {
            console.error(`AMG8833 reading row ${i} is invalid.`);
            return null;
        }
        for (let j = 0; j < matrix[i].length; j++) {
            sum += matrix[i][j];
            count++;
        }
    }
    const avg = sum / count;
    return { raw: matrix, avg };
}

/**
 * Creates an 8x8 blank matrix (filled with zeros).
 * This is used as a fallback when a sensor is missing.
 *
 * @returns {number[][]} A blank 8x8 matrix.
 */
function createBlankMatrix() {
    return Array.from({ length: 8 }, () => Array(8).fill(0));
}

/**
 * Calculates a weighted average with progressive weighting (more recent values weighted higher).
 */
function calculateWeightedAverage(buffer) {
    if (!buffer.length) return 0;
    const weights = buffer.map((_, i) => i + 1);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    return buffer.reduce((sum, value, i) => sum + (value * weights[i]), 0) / weightSum;
}

/**
 * Calculates VPD = SVP - AVP using the Magnus formula.
 */
function calculateVPD(tempC, rh) {
    const a = 17.27;
    const b = 237.7;
    const svp = 0.611 * Math.exp((a * tempC) / (b + tempC));
    const avp = svp * (rh / 100);
    return svp - avp; 
}

/**
 * Adds a value to a FIFO buffer.
 */
function updateSensorBuffer(type, value) {
    if (!sensorBuffers[type]) return;
    sensorBuffers[type].push(value);
    if (sensorBuffers[type].length > BUFFER_SIZE) {
        sensorBuffers[type].shift();
    }
}

/**
 * Logs and formats thermal data for a single AMG8833 reading.
 */
function processThermalData(thermalReadingsArray) {
    if (!thermalReadingsArray || !thermalReadingsArray.length) return null;
    const processedData = thermalReadingsArray.map(reading => {
        if (!reading) return null;
        return {
            dimensions: ['row', 'col', 'temp'],
            source: reading.flatMap((row, i) =>
                row.map((temp, j) => [i, j, temp])
            )
        };
    }).filter(data => data !== null);
    return processedData;
}

/**
 * Processes incoming sensor data, logs it, and returns a payload for the client.
 *
 * Enhancements:
 *  - For each AMG8833 reading, process it once (via processAMG8833Reading) to obtain both the average and raw data.
 *  - Store the latest processed reading for ESP32_1 (left) and ESP32_2 (right).
 *  - Use the computed average to update the canopy temperature sensor buffer.
 *  - When combining for the thermal map, if one sensor is missing (or hasn't sent data yet),
 *    use a blank 8x8 matrix as a fallback.
 */
function processAndLogData(sensorData) {
    const timestamp = Date.now();
    const today = new Date().toISOString().split('T')[0];

    // --- 1) Update buffers for SCD30 readings ---
    if (sensorData.SCD30) {
        const { temp, humidity, co2 } = sensorData.SCD30;
        if (typeof temp === 'number') {
            updateSensorBuffer('temperature', temp);
        }
        if (typeof humidity === 'number') {
            updateSensorBuffer('humidity', humidity);
        }
        if (typeof co2 === 'number') {
            updateSensorBuffer('co2', co2);
        }
    }

    // --- 2) Process AMG8833 thermal data (for both canopy average and thermal map) ---
    if (sensorData.AMG8833) {
        if (sensorData._source && sensorData._hasThermal) {
            const processed = processAMG8833Reading(sensorData.AMG8833);
            if (processed) {
                // For our two dedicated thermal sensors, store the processed object.
                if (sensorData._source === '/dev/esp32_1' || sensorData._source === '/dev/esp32_2') {
                    thermalReadings[sensorData._source] = processed;
                }
                // Update the thermal buffer with the computed average.
                updateSensorBuffer('thermal', processed.avg);
            }
        }
    }

    // --- 3) Compute weighted averages for other sensors ---
    const avgTemp     = calculateWeightedAverage(sensorBuffers.temperature);
    const avgHumidity = calculateWeightedAverage(sensorBuffers.humidity);
    const avgCO2      = calculateWeightedAverage(sensorBuffers.co2);
    const avgThermal  = calculateWeightedAverage(sensorBuffers.thermal);

    // --- 4) Calculate VPD using a double weight for the canopy (thermal) temperature ---
    const tempForVPD = (avgTemp + 2 * avgThermal) / 3;
    const vpd = calculateVPD(tempForVPD, avgHumidity);

    // --- 5) Log the main sensor data ---
    const logData = {
        timestamp,
        temperature: parseFloat(avgTemp.toFixed(1)),
        humidity: parseFloat(avgHumidity.toFixed(1)),
        co2: Math.round(avgCO2),
        vpd: parseFloat(vpd.toFixed(2)),
        leaf_temperature: parseFloat(avgThermal.toFixed(2))
    };
    LogManager.logSensorData(logData, 'sensor');

    // --- 6) Log individual thermal data ---
    if (sensorData.AMG8833) {
        const processedThermal = processThermalData([sensorData.AMG8833]);
        if (processedThermal) {
            LogManager.logSensorData({ timestamp, data: processedThermal }, 'thermal');
        }
    }

    // --- 7) Combine the stored left and right thermal readings for the thermal map ---
    // Use a blank matrix as fallback if one sensor's reading is missing.
    const leftMatrix  = thermalReadings['/dev/esp32_1'] ? thermalReadings['/dev/esp32_1'].raw : createBlankMatrix();
    const rightMatrix = thermalReadings['/dev/esp32_2'] ? thermalReadings['/dev/esp32_2'].raw : createBlankMatrix();

    let combinedThermalHeatmap = null;
    const combinedThermalMatrix = combineThermalData(leftMatrix, rightMatrix);
    if (combinedThermalMatrix) {
        combinedThermalHeatmap = transformCombinedToHeatmapData(combinedThermalMatrix);
    }

    // --- 8) Return payload for WebSocket / client usage ---
    return {
        timestamp,
        vpd,
        averages: {
            temp: avgTemp,
            humidity: avgHumidity,
            co2: avgCO2,
            thermal: avgThermal
        },
        leaf_temp: avgThermal,
        thermalHeatmap: combinedThermalHeatmap,
        raw: sensorData
    };
}

module.exports = {
    processAndLogData,
    calculateVPD,
    processThermalData
};
