// routes/StaticRoutes.js
const express = require('express');
const path = require('path');
const router = express.Router();

// Serve static files from public directory
router.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Serve Chart.js dependencies
router.get('/chart.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules/chart.js/dist/chart.js'));
});

router.get('/dragdata.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules/chartjs-plugin-dragdata/dist/chartjs-plugin-dragdata.esm.js'));
});

// Serve main application page
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Serve documentation
router.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'docs.html'));
});

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: Date.now()
    });
});

// Version info
router.get('/version', (req, res) => {
    try {
        const packageJson = require('../package.json');
        res.json({
            version: packageJson.version,
            name: packageJson.name,
            description: packageJson.description
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Could not retrieve version information' 
        });
    }
});

module.exports = router;
