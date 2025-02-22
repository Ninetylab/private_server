/***********************************************************************
 *  server.js - Main Entry for Your Grow Controller Back-End
 ***********************************************************************/
const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const LogManager = require('./lib/LogManager');
const readline = require('readline');

// Load existing modules
const sensorProcessor = require('./lib/SensorProcess');
const { loadState, saveState } = require('./lib/StateManager');
const SerialManager = require('./lib/SerialManager');
// Require hardware history routes (do not use app yet)
const hardwareHistoryRoutes = require('./routes/hardware-history');

// Import ControlLogic (refactored with scheduling table and fan curve logic)
const ControlLogic = require('./lib/ControlLogic');

// 1) Initialize Express
const app = express();
app.use(express.json());

// Register the hardware history routes under /api
app.use('/api', hardwareHistoryRoutes);

// Serve static files from the public directory with proper MIME types for CSS
app.use('/lib', express.static(path.join(__dirname, 'public/lib'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        }
    }
}));
app.use(express.static(__dirname));

// 2) Load the persisted state (from state.json) and merge with defaults
let state = loadState();

// Get the local IP address for network access logging
const networkInterfaces = os.networkInterfaces();
const localIP = Object.values(networkInterfaces)
    .flat()
    .filter(details => details.family === 'IPv4' && !details.internal)
    .map(details => details.address)[0];

// 3) Set up HTTP server and WebSocket servers
const server = app.listen(8000, '0.0.0.0', () => {
    console.log(`Server running on:`);
    console.log(`- Local:   http://localhost:8000`);
    console.log(`- Network: http://${localIP}:8000`);
    console.log(`Logs directory: ${path.resolve('logs')}`);
});

// Main WebSocket server for GUI clients
const wss = new WebSocket.Server({ server });

// Separate WebSocket server for Pi clients
const wssPi = new WebSocket.Server({ 
    port: 8001, 
    host: '0.0.0.0'
});

// 4) Initialize ControlLogic with the loaded state and both WebSocket servers.
// ControlLogic.init() will recalculate schedules (using our new table-based approach)
// and start its periodic control loop (including fan curve and scheduling logic).
ControlLogic.init(state, wss, wssPi);

// Add connection status tracking
let connectionStatus = {
    pi: false,
    esp1: false,
    esp2: false,
    esp3: false,
    server: true
};

// Function to broadcast connection status to all clients
function broadcastConnectionStatus() {
    const statusUpdate = {
        type: 'connection_status',
        data: connectionStatus
    };
    console.log('[Server] Broadcasting connection status:', statusUpdate);
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(statusUpdate));
        }
    });
}

// Handle Pi WebSocket connections
wssPi.on('connection', (ws) => {
    console.log('Pi connected on control port');
    connectionStatus.pi = true;
    broadcastConnectionStatus();
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('[Pi Response]', message);
        } catch (error) {
            console.error('Error parsing Pi message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Pi disconnected from control port');
        connectionStatus.pi = false;
        broadcastConnectionStatus();
    });
});

// Handle ESP status updates from SerialManager
SerialManager.on('connection_status', (status) => {
    console.log('[Server] Received ESP status update:', status);
    const oldStatus = { ...connectionStatus };
    
    connectionStatus = {
        ...connectionStatus,
        ...status
    };
    
    // Only broadcast if something changed
    if (JSON.stringify(oldStatus) !== JSON.stringify(connectionStatus)) {
        broadcastConnectionStatus();
    }
});

// 5) Bind routes for state management and hardware control
const StateRoutes = require('./routes/StateRoutes');
app.use('/', StateRoutes(state, saveState, wss));

const StaticRoutes = require('./routes/StaticRoutes');
app.use('/', StaticRoutes);

// Add the new sensor history routes
const SensorHistoryRoutes = require('./routes/SensorHistoryRoutes');
app.use('/api', SensorHistoryRoutes);

// If you have a separate route for direct hardware commands, bind it too:
//const ControlRoutes = require('./routes/ControlRoutes');
//app.use('/', ControlRoutes);

// On new GUI client connection, send current connection status
wss.on('connection', (ws) => {
    console.log('New GUI client connected');
    
    // Send current status immediately
    ws.send(JSON.stringify({ 
        type: 'connection_status', 
        data: connectionStatus 
    }));
    
    // Then send state
    ws.send(JSON.stringify({ type: 'state', data: state }));
});

// 7) Continuously receive sensor data via SerialManager
SerialManager.on('data', (rawData) => {
    try {
        const processed = sensorProcessor.processAndLogData(rawData);
        if (processed && processed.averages) {
            // Broadcast sensor data update to GUI clients
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    const guiUpdate = {
                        type: 'sensor_update',
                        data: {
                            Temp: processed.averages.temp.toFixed(1),
                            Co2: Math.round(processed.averages.co2).toString(),
                            VPD: processed.vpd.toFixed(2),
                            CanopyTemp: processed.leaf_temp.toFixed(1),
                            RH: processed.averages.humidity.toFixed(1),
                            Solution_EC: state.setpoints.Sub_EC_setpoint || "0.00",
                            Solution_PH: "0.00",
                            Sub_EC: "0.00",
                            Sub_Moist: "0.0",
                            thermalHeatmap: processed.thermalHeatmap
                        }
                    };
                    // Add debug logging for thermal data
                    if (processed.thermalHeatmap) {
                        if (!Array.isArray(processed.thermalHeatmap) || processed.thermalHeatmap.length === 0) {
                            console.log('[Server] Warning: Invalid thermal data format');
                        }
                    }
                    client.send(JSON.stringify(guiUpdate));
                }
            });

            // Pass sensor data to ControlLogic (which uses it for scheduling and fan control)
            ControlLogic.onNewSensorData(processed);

            // Log sensor data summary
            console.log('\n=== Data Processing Summary ===');
            console.log('Timestamp:', new Date().toISOString());
            console.log('- Avg Temp:', processed.averages.temp.toFixed(1), '°C');
            console.log('- Avg Humidity:', processed.averages.humidity.toFixed(1), '%');
            console.log('- Avg CO2:', Math.round(processed.averages.co2), 'ppm');
            console.log('- VPD:', processed.vpd.toFixed(2), 'kPa');
            console.log('- Leaf Temp:', processed.leaf_temp.toFixed(1), '°C');
            console.log('============================\n');
        }
    } catch (error) {
        console.error('Serial data handling error:', error);
    }
});

// 8) Send system metrics (CPU, RAM) every 5 seconds
let lastCpuInfo = os.cpus();
setInterval(() => {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    let lastTotalIdle = 0;
    let lastTotalTick = 0;

    cpus.forEach((cpu, i) => {
        for (let type in cpu.times) {
            totalTick += cpu.times[type];
            lastTotalTick += lastCpuInfo[i].times[type];
        }
        totalIdle += cpu.times.idle;
        lastTotalIdle += lastCpuInfo[i].times.idle;
    });

    const idleDiff = totalIdle - lastTotalIdle;
    const tickDiff = totalTick - lastTotalTick;
    const cpuUsage = ((1 - idleDiff / tickDiff) * 100).toFixed(1);
    lastCpuInfo = cpus;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ramUsage = ((1 - freeMem / totalMem) * 100).toFixed(1);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'system_metrics',
                data: {
                    cpu: parseFloat(cpuUsage),
                    ram: parseFloat(ramUsage)
                }
            }));
        }
    });
}, 5000);

// 9) Robust error handling for both WebSocket servers.
wss.on('error', (error) => {
    console.error('GUI WebSocket Error:', error);
});
wss.on('close', () => {
    console.log('GUI WebSocket server closed');
});
wssPi.on('error', (error) => {
    console.error('Pi WebSocket Error:', error);
});
wssPi.on('close', () => {
    console.log('Pi WebSocket server closed');
});

// 10) Log active connections every 30 seconds.
setInterval(() => {
    const guiClients = [...wss.clients].length;
    const piClients = [...wssPi.clients].length;
    console.log(`Active connections - GUI: ${guiClients}, Pi: ${piClients}`);
}, 600000);

/**
 * updateLog(message)
 * Moves the terminal cursor to the top left, clears the screen downward,
 * and writes a new log message.
 *
 * @param {string} message - The new log message to display.
 */
function updateLog(message) {
    // Move the cursor to the top-left corner (column 0, row 0)
    readline.cursorTo(process.stdout, 0, 0);
    
    // Clear the screen starting from the current cursor position downward
    readline.clearScreenDown(process.stdout);
    
    // Write the new log message to the terminal
    process.stdout.write(message);
}
