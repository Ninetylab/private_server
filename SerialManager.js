// lib/SerialManager.js

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { EventEmitter } = require('events');
const fs = require('fs').promises;
const fsSync = require('fs');

class SerialManager extends EventEmitter {
    constructor() {
        super();

        // Define device identifiers
        this.DEVICES = {
            MEGA: {
                vid: '2341',  // Arduino SA
                pid: '0042',  // Mega 2560 R3
                name: 'Arduino Mega 2560'
            }
        };

        // Chemins vers tes 3 ESP et Arduino Mega
        this.portsConfig = [
            { path: '/dev/esp32_1', hasAMG8833: true },
            { path: '/dev/esp32_2', hasAMG8833: true },
            { path: '/dev/esp32_3', hasAMG8833: false }
        ];

        this.serialPorts = [];
        this.portStatus = {
            esp1: false,
            esp2: false,
            esp3: false,
            soil: false
        };

        this.megaPort = null;
        
        // Check USB device presence every 2 seconds
        setInterval(() => this.checkDevicePresence(), 2000);
        
        this.initPorts();
    }

    async findMegaPort() {
        try {
            const ports = await SerialPort.list();
            for (const port of ports) {
                if (port.vendorId === this.DEVICES.MEGA.vid && 
                    port.productId === this.DEVICES.MEGA.pid) {
                    console.log(`[SerialManager] Found ${this.DEVICES.MEGA.name} at ${port.path}`);
                    return port.path;
                }
            }
            return null;
        } catch (err) {
            console.error('[SerialManager] Error listing ports:', err);
            return null;
        }
    }

    async checkDevicePresence() {
        try {
            // Check for Mega first
            const megaPath = await this.findMegaPort();
            if (megaPath) {
                if (!this.megaPort || this.megaPort.path !== megaPath) {
                    // New Mega connection detected
                    if (this.megaPort) {
                        this.megaPort.close();
                    }
                    await this.initMegaPort(megaPath);
                }
            } else if (this.megaPort) {
                // Mega disconnected
                this.megaPort.close();
                this.megaPort = null;
                this.portStatus.soil = false;
                this.emit('connection_status', this.getConnectionStatus());
                console.log('[SerialManager] Arduino Mega disconnected');
            }

            // Check other ESP devices
            for (let index = 0; index < this.portsConfig.length; index++) {
                const cfg = this.portsConfig[index];
                const espNum = index + 1;
                const espKey = `esp${espNum}`;
                
                try {
                    await fs.stat(cfg.path);
                    const isPresent = true;
                    
                    if (this.portStatus[espKey] !== isPresent) {
                        this.portStatus[espKey] = isPresent;
                        console.log(`[SerialManager] ESP${espNum} device detected at ${cfg.path}`);
                        
                        if (isPresent && !this.serialPorts[index]) {
                            this.initPort(cfg, espNum);
                        }
                        
                        this.emit('connection_status', this.getConnectionStatus());
                    }
                } catch (err) {
                    const isPresent = false;
                    
                    if (this.portStatus[espKey] !== isPresent) {
                        this.portStatus[espKey] = isPresent;
                        console.log(`[SerialManager] ESP${espNum} device removed from ${cfg.path}`);
                        
                        if (this.serialPorts[index]) {
                            this.serialPorts[index].close();
                            this.serialPorts[index] = null;
                        }
                        
                        this.emit('connection_status', this.getConnectionStatus());
                    }
                }
            }
        } catch (err) {
            console.error('[SerialManager] Error checking device presence:', err);
        }
    }

    async initMegaPort(path) {
        try {
            const port = new SerialPort({
                path: path,
                baudRate: 115200
            });
            
            port.on('error', (err) => {
                console.error(`[SerialManager] Error on Mega port ${path}:`, err);
                this.portStatus.soil = false;
                this.megaPort = null;
                this.emit('connection_status', this.getConnectionStatus());
            });

            port.on('close', () => {
                console.log(`[SerialManager] Mega port closed: ${path}`);
                this.portStatus.soil = false;
                this.megaPort = null;
                this.emit('connection_status', this.getConnectionStatus());
            });

            const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
            parser.on('data', (line) => {
                console.log(`[SerialManager] ${path} RAW: "${line}"`);
                const dataObj = this.parseESPLine(line.trim());
                if (dataObj) {
                    dataObj._source = path;
                    dataObj._isSoilSensor = true;
                    this.emit('data', dataObj);
                }
            });

            this.megaPort = port;
            this.portStatus.soil = true;
            this.emit('connection_status', this.getConnectionStatus());
            console.log(`[SerialManager] Successfully initialized Mega port ${path}`);
        } catch (err) {
            console.error(`[SerialManager] Failed to initialize Mega port ${path}:`, err);
            this.portStatus.soil = false;
            this.megaPort = null;
            this.emit('connection_status', this.getConnectionStatus());
        }
    }

    async initPorts() {
        try {
            for (let index = 0; index < this.portsConfig.length; index++) {
                const cfg = this.portsConfig[index];
                const espNum = index + 1;
                const espKey = `esp${espNum}`;
                
                try {
                    // Check if device exists
                    await fs.access(cfg.path);
                    this.portStatus[espKey] = true;
                    await this.initPort(cfg, espNum);
                } catch (err) {
                    this.portStatus[espKey] = false;
                    console.log(`[SerialManager] ESP${espNum} not found at ${cfg.path}`);
                }
            }
            
            // Emit initial status
            this.emit('connection_status', this.getConnectionStatus());
        } catch (err) {
            console.error('[SerialManager] Error initializing ports:', err);
        }
    }

    async initPort(cfg, espNum) {
        try {
            const port = new SerialPort({
                path: cfg.path,
                baudRate: 115200
            });
            
            port.on('error', (err) => {
                console.error(`[SerialManager] Error on ${cfg.path}:`, err);
                this.portStatus[`esp${espNum}`] = false;
                this.emit('connection_status', this.getConnectionStatus());
            });

            port.on('close', () => {
                console.log(`[SerialManager] Port closed: ${cfg.path}`);
                this.portStatus[`esp${espNum}`] = false;
                this.emit('connection_status', this.getConnectionStatus());
            });

            const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
            parser.on('data', (line) => {
                console.log(`[SerialManager] ${cfg.path} RAW: "${line}"`);
                const dataObj = this.parseESPLine(line.trim());
                if (dataObj) {
                    dataObj._source = cfg.path;
                    dataObj._hasThermal = cfg.hasAMG8833;
                    this.emit('data', dataObj);
                }
            });

            this.serialPorts[espNum - 1] = port;
            console.log(`[SerialManager] Successfully initialized port ${cfg.path}`);
        } catch (err) {
            console.error(`[SerialManager] Failed to initialize port ${cfg.path}:`, err);
            this.portStatus[`esp${espNum}`] = false;
            this.emit('connection_status', this.getConnectionStatus());
        }
    }

    getConnectionStatus() {
        return {
            esp1: this.portStatus.esp1,
            esp2: this.portStatus.esp2,
            esp3: this.portStatus.esp3,
            soil: this.portStatus.soil
        };
    }

    /**
     * parseESPLine(line):
     * - Détecte la ligne SCD30 ou AMG8833 envoyée par l'ESP (sans "ESPx" devant).
     * - Exemples:
     *    "SCD30 -> CO2: 794.97 ppm, Temp: 21.07 C, RH: "0.71 %"
     *    "AMG8833 -> 17.50 17.50 17.75 ..."
     * - Retourne { SCD30: {...} } ou { AMG8833: [[...],[...]] } exploitable par sensorProcessor.
     * - Retourne null si non reconnu.
     */
    parseESPLine(line) {
        // Retirer les guillemets parasites
        line = line.replace(/"/g, '');

        // SOIL format:
        // "SOIL -> RAW:620,580,590,600,610,605,595 PCT:45,65,60,55,50,52,58"
        const soilRegex = /^SOIL\s*->\s*RAW:([\d,]+)\s*PCT:([\d,]+)/;

        // Check for soil moisture data first
        let match = soilRegex.exec(line);
        if (match) {
            const rawValues = match[1].split(',').map(v => parseInt(v));
            const pctValues = match[2].split(',').map(v => parseInt(v));
            
            if (rawValues.length === 7 && pctValues.length === 7) {
                return {
                    SOIL: {
                        raw: rawValues,
                        moisture: pctValues
                    }
                };
            }
            return null;
        }

        // Existing SCD30 format
        const scd30Regex = /^SCD30\s*->\s*CO2:\s*([\d.]+)\s*ppm,\s*Temp:\s*([\d.]+)\s*C,\s*RH:\s*([\d.]+)\s*%/;

        // AMG8833 format
        const amgRegex = /^AMG8833\s*->\s*([\d.\s]+)/;

        // Check SCD30
        match = scd30Regex.exec(line);
        if (match) {
            const co2  = parseFloat(match[1]);
            const temp = parseFloat(match[2]);
            const rh   = parseFloat(match[3]);

            return {
                SCD30: {
                    co2: isNaN(co2) ? 0 : co2,
                    temp: isNaN(temp) ? 0 : temp,
                    humidity: isNaN(rh) ? 0 : rh
                }
            };
        }

        // Check AMG8833
        match = amgRegex.exec(line);
        if (match) {
            const pixStr = match[1].trim();
            const pixParts = pixStr.split(/\s+/);

            if (pixParts.length === 64) {
                const floats = pixParts.map(p => parseFloat(p) || 0);
                const matrix8x8 = [];
                for (let i = 0; i < 8; i++) {
                    matrix8x8.push(floats.slice(i * 8, i * 8 + 8));
                }
                return { AMG8833: matrix8x8 };
            } else {
                console.warn(`[parseESPLine] AMG8833 invalid pixel count: found ${pixParts.length} instead of 64.`);
                return null;
            }
        }

        return null;
    }
}

module.exports = new SerialManager();
