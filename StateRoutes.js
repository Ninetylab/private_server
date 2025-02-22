// routes/StateRoutes.js
const express = require('express');
const router = express.Router();
const ControlLogic = require('../lib/ControlLogic');

module.exports = function(state, saveState, wss) {
    // Get current state
    router.get('/state', (req, res) => {
        res.json(state);
    });

    // Update state (buttons, setpoints, fan curves, etc.)
    router.post('/update', (req, res) => {
        try {
            // Destructure type, id, value, and curve from the request body
            const { type, id, value, curve } = req.body;
            let stateChanged = false;

            if (type === 'button') {
                // Map GUI button IDs to hardware IDs
                const buttonToHardware = {
                    'Btn_Co2_Status_0': 'co2_valve',
                    'Btn_Heat+_0': 'heater_plus',
                    'Btn_Heat-_0': 'heater_minus',
                    'Btn_Dehumidifier_0': 'dehumidifier',
                    'Btn_Humidifier_0': 'humidifier',
                    'Btn_Light_State_0': 'light',
                    'Btn_Irrig_Pump_0': 'irrigation'
                };

                const hardwareId = buttonToHardware[id];
                if (hardwareId) {
                    // Use ControlLogic to handle hardware state changes with manual flag
                    ControlLogic.setHardwareState(hardwareId, value, true);
                    stateChanged = true;
                } else if (id.startsWith('Btn_Step') && id.endsWith('_0')) {
                    // Handle irrigation step buttons
                    state.buttons[id] = value;
                    stateChanged = true;
                } else if (id === 'Btn_Save_Irrig_0') {
                    // Handle irrigation save button
                    state.buttons[id] = value;
                    stateChanged = true;
                    // Trigger irrigation schedule recalculation
                    ControlLogic.recalculateIrrigationSchedule();
                } else if (state.buttons[id] !== value) {
                    // Handle other non-hardware buttons normally
                    state.buttons[id] = value;
                    stateChanged = true;
                }
            } else if (type === 'setpoint') {
                // Update setpoint value
                if (!state.setpoints) state.setpoints = {};
                state.setpoints[id] = value;
                stateChanged = true;

                // Only recalculate schedules for light-related setpoints
                if (id === 'Light_Start_setpoint' || id === 'Light_Shutdown_setpoint') {
                    ControlLogic.recalculateSchedules();
                }
            } else if (type === 'saveFanCurve') {
                // Handle saving of fan curves
                if (!Array.isArray(curve)) {
                    res.status(400).json({ error: 'Invalid curve data format' });
                    return;
                }
                // Create or update the fanCurves property on state
                state.fanCurves = state.fanCurves || {};
                state.fanCurves[id] = curve;

                // Sort the curve data by the x value (temperature)
                state.fanCurves[id].sort((a, b) => a.x - b.x);

                // Notify the control logic of the new fan curve
                if (typeof ControlLogic.setFanCurve === 'function') {
                    ControlLogic.setFanCurve(id, state.fanCurves[id]);
                }
                stateChanged = true;
            }

            if (stateChanged) {
                if (saveState(state)) {
                    // Broadcast update to all connected clients
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'state',
                                data: state
                            }));
                        }
                    });
                    res.json({ success: true });
                } else {
                    res.status(500).json({
                        success: false,
                        error: 'Failed to save state'
                    });
                }
            } else {
                res.json({ success: true, message: 'No changes needed' });
            }
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
};
