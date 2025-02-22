// routes/hardware-history.js
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

// Helper to parse a line of hardware log data
function parseHardwareLine(line) {
    try {
        return JSON.parse(line);
    } catch (error) {
        console.error('Error parsing hardware log line:', error);
        return null;
    }
}

router.get('/hardware-history', async (req, res) => {
    try {
        const { start, end } = req.query;
        const startTime = parseInt(start) || Date.now() - 24 * 60 * 60 * 1000; // default last 24h
        const endTime = parseInt(end) || Date.now();

        const logsDir = path.join(__dirname, '..', 'logs');
        const files = await fs.readdir(logsDir);
        // Look for files ending with _hardware_data.log
        const hardwareFiles = files.filter(f => f.endsWith('_hardware_data.log'));

        const allData = [];
        for (const file of hardwareFiles) {
            const content = await fs.readFile(path.join(logsDir, file), 'utf-8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
                const data = parseHardwareLine(line);
                if (data && data.timestamp >= startTime && data.timestamp <= endTime) {
                    allData.push(data);
                }
            }
        }

        // Sort the data by timestamp
        allData.sort((a, b) => a.timestamp - b.timestamp);
        
        res.json({
            success: true,
            data: allData
        });
    } catch (error) {
        console.error('Error fetching hardware history:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;