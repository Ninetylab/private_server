const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

// Helper function to parse a line of sensor data
function parseSensorLine(line) {
    try {
        const data = JSON.parse(line);
        return {
            timestamp: data.timestamp,
            temperature: data.temperature,
            humidity: data.humidity,
            co2: data.co2,
            vpd: data.vpd
        };
    } catch (error) {
        console.error('Error parsing sensor data line:', error);
        return null;
    }
}

// Helper function to aggregate data points to reduce data volume
function aggregateData(data, intervalMinutes = 5) {
    const intervalMs = intervalMinutes * 60 * 1000;
    const aggregated = new Map();

    data.forEach(point => {
        const timeKey = Math.floor(point.timestamp / intervalMs) * intervalMs;
        if (!aggregated.has(timeKey)) {
            aggregated.set(timeKey, {
                count: 0,
                temperature: 0,
                humidity: 0,
                co2: 0,
                vpd: 0
            });
        }
        const agg = aggregated.get(timeKey);
        agg.count++;
        agg.temperature += point.temperature;
        agg.humidity += point.humidity;
        agg.co2 += point.co2;
        agg.vpd += point.vpd;
    });

    return Array.from(aggregated.entries()).map(([timestamp, agg]) => ({
        timestamp,
        temperature: agg.temperature / agg.count,
        humidity: agg.humidity / agg.count,
        co2: agg.co2 / agg.count,
        vpd: agg.vpd / agg.count
    }));
}

router.get('/sensor-history', async (req, res) => {
    try {
        const { start, end, interval } = req.query;
        const startTime = parseInt(start) || Date.now() - 24 * 60 * 60 * 1000; // Default to last 24 hours
        const endTime = parseInt(end) || Date.now();
        const aggregationInterval = parseInt(interval) || 5; // Default to 5-minute intervals

        // Get list of log files in the logs directory
        const logsDir = path.join(__dirname, '..', 'logs');
        const files = await fs.readdir(logsDir);
        const logFiles = files.filter(f => f.endsWith('_sensor_data.log'));

        // Read and process each log file
        const allData = [];
        for (const file of logFiles) {
            const content = await fs.readFile(path.join(logsDir, file), 'utf-8');
            const lines = content.trim().split('\n');
            
            for (const line of lines) {
                const data = parseSensorLine(line);
                if (data && data.timestamp >= startTime && data.timestamp <= endTime) {
                    allData.push(data);
                }
            }
        }

        // Sort data by timestamp
        allData.sort((a, b) => a.timestamp - b.timestamp);

        // Aggregate data to reduce volume
        const aggregatedData = aggregateData(allData, aggregationInterval);

        res.json({
            success: true,
            data: aggregatedData
        });

    } catch (error) {
        console.error('Error fetching sensor history:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch sensor history',
            details: error.message
        });
    }
});

module.exports = router; 