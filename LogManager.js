const fs = require('fs');
const path = require('path');
const winston = require('winston');

class LogManager {
    constructor() {
        // Logs actifs dans le dossier du projet
        this.activeLogsPath = path.join(process.cwd(), 'logs');
        // Archives dans /var/Server_logs
        this.archiveLogsPath = '/var/Server_logs/archive';
        
        // Créer les dossiers nécessaires
        this.ensureDirectories();
        
        // Configurer Winston
        this.setupWinston();
    }

    ensureDirectories() {
        // Créer le dossier des logs actifs
        if (!fs.existsSync(this.activeLogsPath)) {
            fs.mkdirSync(this.activeLogsPath, { recursive: true });
        }

        // Vérifier les permissions du dossier actif
        try {
            fs.accessSync(this.activeLogsPath, fs.constants.W_OK);
        } catch (err) {
            console.error(`Warning: No write access to ${this.activeLogsPath}. Logs may fail.`);
        }
    }

    setupWinston() {
        this.logger = winston.createLogger({
            level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.File({
                    filename: path.join(this.activeLogsPath, 'error.log'),
                    level: 'error',
                    maxsize: 5242880, // 5MB
                    maxFiles: 5
                }),
                new winston.transports.File({
                    filename: path.join(this.activeLogsPath, 'combined.log'),
                    maxsize: 5242880, // 5MB
                    maxFiles: 5
                })
            ],
            exceptionHandlers: [
                new winston.transports.File({
                    filename: path.join(this.activeLogsPath, 'exceptions.log'),
                    maxsize: 1048576, // 1MB
                    maxFiles: 3
                })
            ]
        });
    }

    getArchivePath(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return path.join(this.archiveLogsPath, String(year), month);
    }

    checkAndRotateFile(filePath, maxSize = 5242880) {
        try {
            const stats = fs.statSync(filePath);
            if (stats.size >= maxSize) {
                const date = new Date();
                const archivePath = this.getArchivePath(date);
                
                // Créer le dossier d'archive si nécessaire
                if (!fs.existsSync(archivePath)) {
                    try {
                        fs.mkdirSync(archivePath, { 
                            recursive: true,
                            mode: 0o755 // rwxr-xr-x
                        });
                    } catch (err) {
                        console.error(`Failed to create archive directory: ${err.message}`);
                        return; // Ne pas continuer si on ne peut pas créer le dossier d'archive
                    }
                }

                // Déplacer le fichier vers l'archive
                const fileName = path.basename(filePath);
                const timestamp = date.toISOString().replace(/[:.]/g, '-');
                const archiveFileName = `${timestamp}_${fileName}`;
                const archiveFilePath = path.join(archivePath, archiveFileName);
                
                try {
                    fs.renameSync(filePath, archiveFilePath);
                    // Créer un nouveau fichier vide
                    fs.writeFileSync(filePath, '');
                    console.log(`Rotated ${fileName} to archive: ${archiveFilePath}`);
                } catch (err) {
                    console.error(`Failed to rotate log file: ${err.message}`);
                    // En cas d'échec de rotation, on vide simplement le fichier
                    fs.writeFileSync(filePath, '');
                }
            }
        } catch (error) {
            console.error('Error during file rotation:', error);
        }
    }

    logSensorData(data, type = 'sensor') {
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(this.activeLogsPath, `${today}_${type}_data.log`);
        
        // Create file if it doesn't exist
        if (!fs.existsSync(logFile)) {
            fs.writeFileSync(logFile, '');
        }
        
        // Vérifier et faire la rotation si nécessaire
        this.checkAndRotateFile(logFile);
        
        // Log avec Winston pour le debugging
        if (type === 'thermal') {
            this.logger.debug('Thermal data received:', {
                timestamp: data.timestamp,
                dataPoints: data.data ? data.data.length : 0,
                type: 'thermal'
            });
        }
        
        // Ajouter les nouvelles données
        const logEntry = JSON.stringify(data) + '\n';
        fs.appendFileSync(logFile, logEntry);
        
        // Log supplémentaire pour les données thermiques
        if (type === 'thermal') {
            console.log('[LogManager] Thermal data logged:', {
                file: logFile,
                timestamp: data.timestamp,
                dataPoints: data.data ? data.data.length : 0
            });
        }
    }

    setArchivePath(newPath) {
        this.archiveLogsPath = path.join(newPath, 'archive');
        console.log('Archive path updated:', this.archiveLogsPath);
    }

    logHardwareState(data) {
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(this.activeLogsPath, `${today}_hardware_data.log`);
        
        // Create file if it doesn't exist
        if (!fs.existsSync(logFile)) {
            fs.writeFileSync(logFile, '');
        }
        
        // Check for rotation (reuse the existing function)
        this.checkAndRotateFile(logFile);
        
        const logEntry = JSON.stringify(data) + '\n';
        fs.appendFileSync(logFile, logEntry);
    }      
}

module.exports = new LogManager(); 