    /**
     * ControlLogic.js
     *
     * Ce module gère la logique de contrôle en temps réel :
     * - Récupère setpoints (Temp, Co2, etc.) et données capteurs
     * - Applique des règles STC simples (ex: CO2 < sp => open valve)
     * - Envoie des commandes hardware via WebSocket (ex: "hardware_cmd")
     * - Met à jour le state/buttons pour refléter la réalité
     * - Gère les schedulers (lumière et irrigation) de manière efficace en utilisant des tableaux de programmation
     * - Traite la fan curve et envoie une commande PWM basée sur la température actuelle.
     *
     * Cette version utilise la persistance du state (par exemple, depuis state.json)
     * pour recalculer les horaires après un redémarrage et emploie un vérificateur de
     * planning unique (toutes les 10 secondes) afin de réduire la charge sur le serveur.
     */

    const EventEmitter = require('events');
    const ScheduleManager = require('./ScheduleManager');
    const LogManager = require('./LogManager');

    class ControlLogic extends EventEmitter {
        constructor() {
            super();
            this.state = null;         
            this.wss = null;           
            this.wssPi = null;         
            this.lastSensorData = {};  
            this.lastHardwareCmd = {}; 
            this.manualOverride = {};  
            
            // Interval reference for cleanup
            this._controlLoopInterval = null;
            
            // Fan curve properties
            this.fanCurves = {};      
            this.lastFanSpeed = null;  

            // Initialize schedule manager
            this.scheduleManager = new ScheduleManager(this);
        }

        /**
         * init(state, wss, wssPi)
         * Doit être appelée une seule fois (après chargement du state depuis state.json)
         * @returns {boolean} true if initialization successful
         */
        init(state, wss, wssPi) {
            try {
                // Cleanup any existing interval
                if (this._controlLoopInterval) clearInterval(this._controlLoopInterval);
                
                this.state = state;
                this.wss = wss;
                this.wssPi = wssPi;

                // Initialize schedule manager
                this.scheduleManager.init();

                // Start control loop
                this._controlLoopInterval = setInterval(() => this.runControlLoop(), 5000);

                console.log('[ControlLogic] init OK');
                return true;
            } catch (error) {
                console.error('[ControlLogic] init failed:', error);
                return false;
            }
        }

        /**
         * onNewSensorData(processed)
         * Appelé lorsque de nouvelles données capteurs sont reçues.
         */
        onNewSensorData(processed) {
            this.lastSensorData = {
                temp: processed.averages.temp,
                co2: processed.averages.co2,
                humidity: processed.averages.humidity,
                vpd: processed.vpd,
                canopy: processed.leaf_temp,
                timestamp: Date.now()  // Add timestamp
            };
            this.runControlLoop();
        }

        /**
         * runControlLoop()
         * Exécute la logique de contrôle pour CO2, humidité, chauffage et met à jour le ventilateur via le fan curve.
         */
        runControlLoop() {
            if (!this.state || !this.lastSensorData) return;
            const now = Date.now();
            const MAX_SENSOR_AGE_MS = 30000;
            
            // Skip control if sensor data is too old.
            if (!this.lastSensorData.timestamp || (now - this.lastSensorData.timestamp) > MAX_SENSOR_AGE_MS) {
            return;
            }
            
            // Process control logic only if the sensor reading is new.
            if (this.lastProcessedSensorTimestamp === this.lastSensorData.timestamp) {
            return; // We've already handled this sensor update.
            }
            this.lastProcessedSensorTimestamp = this.lastSensorData.timestamp;
            
            const sp = this.state.setpoints || {};
            
            // ---------- CO₂ Control Logic ----------
            const co2_sp = parseFloat(sp.Co2_setpoint) || 1000;
            const co2_val = this.lastSensorData.co2;
            const CO2_NEG_DEADBAND = 50;
            const CO2_PULSE_DURATION_MS = 2000; // Duration for the GUI pulse
            
            if (!this.manualOverride['co2_valve'] && co2_val !== undefined && co2_val !== null) {
            if (!this.isLightOn()) {
                // Nighttime – always keep the valve off.
                this.setHardwareState('co2_valve', false);
            } else if (co2_val < (co2_sp - CO2_NEG_DEADBAND)) {
                // If the sensor reading is below threshold, trigger one pulse:
                this.setHardwareState('co2_valve', true);
                // Schedule turning the valve off after the pulse duration.
                setTimeout(() => {
                this.setHardwareState('co2_valve', false);
                }, CO2_PULSE_DURATION_MS);
            } else {
                // Otherwise, ensure the valve is off.
                this.setHardwareState('co2_valve', false);
            }
            }
            // ---------- End CO₂ Control Logic ----------
            
          // ---------- VPD Control with True Hysteresis ----------

if (!this.manualOverride['humidifier'] && !this.manualOverride['dehumidifier']) {
    const vpd_sp = parseFloat(sp.VPD_setpoint) || 1.2;
    const vpd_val = this.lastSensorData.vpd || 0;
    const H = 0.1; // Hysteresis range: ±0.1 around vpd_sp
  
    // Current hardware states
    const isHumOn = !!this.lastHardwareCmd['humidifier'];
    const isDehumOn = !!this.lastHardwareCmd['dehumidifier'];
  
    // Define thresholds
    // - We'll turn dehumidifier ON if vpd_val < (vpd_sp - H),
    //   and only turn it OFF if vpd_val > vpd_sp.
    const dehumOnThreshold  = vpd_sp - H;
    const dehumOffThreshold = vpd_sp;
  
    // - We'll turn humidifier ON if vpd_val > (vpd_sp + H),
    //   and only turn it OFF if vpd_val < vpd_sp.
    const humidOnThreshold  = vpd_sp + H;
    const humidOffThreshold = vpd_sp;
  
    // Decide if we want dehumidifier ON or OFF
    let newDehumState;
    if (isDehumOn) {
      // If it's already ON, we keep it ON until we cross above vpd_sp
      newDehumState = (vpd_val <= dehumOffThreshold);
    } else {
      // If it's currently OFF, we only turn it ON if vpd_val < (vpd_sp - H)
      newDehumState = (vpd_val < dehumOnThreshold);
    }
  
    // Decide if we want humidifier ON or OFF
    let newHumidState;
    if (isHumOn) {
      // If it's already ON, keep it ON until we cross below vpd_sp
      newHumidState = (vpd_val >= humidOffThreshold);
    } else {
      // If it's currently OFF, only turn it ON if vpd_val > (vpd_sp + H)
      newHumidState = (vpd_val > humidOnThreshold);
    }
  
    // Avoid turning both ON at once (shouldn't happen if setpoints are normal),
    // but handle conflict if VPD is exactly at sp in some weird scenario.
    if (newDehumState && newHumidState) {
      // Decide which to prioritize. Typically you never want both on.
      // If vpd_val < vpd_sp, dehumidify; if vpd_val > vpd_sp, humidify
      if (vpd_val < vpd_sp) {
        newHumidState = false; // Dehumidify
      } else {
        newDehumState = false; // Humidify
      }
    }
  
    // Now apply
    this.setHardwareState('dehumidifier', newDehumState);
    this.setHardwareState('humidifier', newHumidState);
  }
  // ---------- End VPD Control Logic ----------
  
  // ---------- Temperature Control Logic ----------
  if (!this.manualOverride['heater_plus'] && !this.manualOverride['heater_minus']) {
    const isHeaterPlusOn  = !!this.lastHardwareCmd['heater_plus'];
    const isHeaterMinusOn = !!this.lastHardwareCmd['heater_minus'];
    
    const heat_sp  = parseFloat(sp.Temp_setpoint) || 25.0;
    const heatHyst = 0.5; // example
    const lowThresh  = heat_sp - heatHyst;
    const highThresh = heat_sp + heatHyst;
    
    const temp_val = this.lastSensorData.temp;
    
    // Turn heater_plus ON if temp_val < lowThresh,
    // keep it ON until temp_val > heat_sp
    let newHeaterPlusState;
    if (isHeaterPlusOn) {
      newHeaterPlusState = (temp_val <= heat_sp);
    } else {
      newHeaterPlusState = (temp_val < lowThresh);
    }
    
    // Turn heater_minus ON if temp_val > highThresh,
    // keep it ON until temp_val < heat_sp
    let newHeaterMinusState;
    if (isHeaterMinusOn) {
      newHeaterMinusState = (temp_val >= heat_sp);
    } else {
      newHeaterMinusState = (temp_val > highThresh);
    }
    
    // If somehow both states are true, pick one.
    if (newHeaterPlusState && newHeaterMinusState) {
      // Decide based on whether temp is above or below the setpoint
      if (temp_val < heat_sp) {
        newHeaterMinusState = false;
      } else {
        newHeaterPlusState = false;
      }
    }
    
    // Apply
    this.setHardwareState('heater_plus', newHeaterPlusState);
    this.setHardwareState('heater_minus', newHeaterMinusState);
  }
  // ---------- End Temperature Control Logic ----------

            // Update fan control based on current temperature and fan curve.
            this.updateFanControl();
        }

        /**
         * setHardwareState(hardwareId, active, isManual = false)
         * Envoie la commande au Pi et met à jour l'état dans le state.
         */
        setHardwareState(hardwareId, active, isManual = false) {
            if (isManual) {
                // For lights, manual override is temporary until next scheduled event
                if (hardwareId === 'light') {
                    this.manualOverride[hardwareId] = true;
                    console.log(`[ControlLogic] Manual light override: ${active ? 'ON' : 'OFF'} (until next scheduled event)`);
                } else {
                    this.manualOverride[hardwareId] = active;
                }
            }
            
            if (this.lastHardwareCmd[hardwareId] === active) return;
            
            this.lastHardwareCmd[hardwareId] = active;
        
            // Handle mutually exclusive devices
            if (active) {
                const exclusiveMap = {
                    'dehumidifier': 'humidifier',
                    'humidifier': 'dehumidifier',
                    'heater_plus': 'heater_minus',
                    'heater_minus': 'heater_plus'
                };
                
                const opposite = exclusiveMap[hardwareId];
                if (opposite) this.setHardwareState(opposite, false, isManual);
            }
        
            // Send to Pi
            if (this.wssPi) {
                const piMsg = {
                    type: 'hardware_cmd',
                    data: { hardwareId, value: active }
                };
                this.sendToPi(piMsg);
            }
        
            // Update GUI
            const buttonId = this.mapHardwareToButton(hardwareId);
            if (buttonId && this.state) {
                this.state.buttons[buttonId] = active;
                this.broadcast({ type: 'state', data: this.state });
            }
        
            // Log the hardware state change
            LogManager.logHardwareState({
                timestamp: Date.now(),
                hardwareId,
                value: active,
                manual: isManual
            });
        }
        

        /**
         * broadcast(msg)
         * Envoie un message JSON à tous les clients WebSocket.
         */
        broadcast(msg) {
            if (!this.wss) return;
            const message = JSON.stringify(msg);
            this.wss.clients.forEach(client => {
                if (client.readyState === 1) client.send(message);
            });
        }

        /**
         * mapHardwareToButton(hardwareId)
         * Retourne l'ID du bouton correspondant.
         */
        mapHardwareToButton(hid) {
            const hwMap = {
                co2_valve: 'Btn_Co2_Status_0',
                heater_plus: 'Btn_Heat+_0',
                heater_minus: 'Btn_Heat-_0',
                dehumidifier: 'Btn_Dehumidifier_0',
                humidifier: 'Btn_Humidifier_0',
                light: 'Btn_Light_State_0',
                irrigation: 'Btn_Irrig_Pump_0'
            };
            return hwMap[hid] || null;
        }

        /**
         * setFanCurve(fanCurveId, curve)
         * Stocke le fan curve et déclenche la mise à jour du contrôle du ventilateur.
         */
        setFanCurve(fanCurveId, curve) {
            this.fanCurves[fanCurveId] = curve;
            console.log(`[ControlLogic] Fan curve ${fanCurveId} updated:`, curve);
            this.updateFanControl();
        }

        /**
         * updateFanControl()
         * Utilise la température actuelle et le fan curve (par défaut "FanCurve1")
         * pour calculer la vitesse du ventilateur (interpolation linéaire).
         * Si la vitesse calculée diffère de la dernière envoyée, un message est envoyé au Pi.
         */
        updateFanControl() {
            if (!this.lastSensorData || typeof this.lastSensorData.temp !== 'number') return;
            
            const speeds = {
                fan1: this.calculateFanSpeed("FanCurve1", this.lastSensorData.temp),
                fan2: this.calculateFanSpeed("FanCurve2", this.lastSensorData.temp)
            };

            if (this.lastFanSpeed !== speeds.fan1) {
                this.lastFanSpeed = speeds.fan1;
                
                // Send to Pi
                if (this.wssPi) {
                    const piMsg = {
                        type: 'fan_pwm',
                        data: { id: "fan_pwm1", value: speeds.fan1 }
                    };
                    this.sendToPi(piMsg);
                }

                // Broadcast to GUI
                this.broadcast({
                    type: 'fan_speeds',
                    data: speeds
                });
            }
        }

        // Add helper method to calculate fan speed
        calculateFanSpeed(curveId, currentTemp) {
            const curve = this.fanCurves[curveId];
            if (!curve || curve.length === 0) return 0;

            if (currentTemp <= curve[0].x) return curve[0].y;
            if (currentTemp >= curve[curve.length - 1].x) return curve[curve.length - 1].y;

            for (let i = 0; i < curve.length - 1; i++) {
                const p1 = curve[i], p2 = curve[i + 1];
                if (currentTemp >= p1.x && currentTemp <= p2.x) {
                    const ratio = (currentTemp - p1.x) / (p2.x - p1.x);
                    return Math.round(p1.y + ratio * (p2.y - p1.y));
                }
            }
            return 0;
        }

        // Handle Pi reconnection
        handlePiReconnect(ws) {
            // Resend current hardware states
            Object.entries(this.lastHardwareCmd).forEach(([hardwareId, value]) => {
                const piMsg = {
                    type: 'hardware_cmd',
                    data: { hardwareId, value }
                };
                this.sendToPi(piMsg);
            });

            // Resend current fan speed if any
            if (this.lastFanSpeed !== null) {
                const fanMsg = {
                    type: 'fan_pwm',
                    data: { id: "fan_pwm1", value: this.lastFanSpeed }
                };
                this.sendToPi(fanMsg);
            }
        }

        // Simple Pi message sender
        sendToPi(msg) {
            if (!this.wssPi) return;
            const msgStr = JSON.stringify(msg);
            this.wssPi.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(msgStr);
                }
            });
        }

        /**
         * recalculateIrrigationSchedule()
         * Recalculates only the irrigation schedule without affecting light schedules.
         */
        recalculateIrrigationSchedule() {
            if (this.scheduleManager) {
                this.scheduleManager.recalculateIrrigationSchedule();
                console.log('[ControlLogic] Irrigation schedule recalculated');
            }
        }

        /**
         * recalculateSchedules()
         * Recalcule et met à jour les tableaux de programmation pour la lumière et l'irrigation.
         * Peut être appelé lors de changements de setpoints (via la persistance).
         */
        recalculateSchedules() {
            if (this.scheduleManager) {
                this.scheduleManager.recalculateSchedules();
            }
        }

        // Add minimal cleanup method
        cleanup() {
            if (this.scheduleManager) {
                this.scheduleManager.cleanup();
            }
        }

        /**
         * isLightOn()
         * Returns true if lights are currently scheduled to be on
         */
        isLightOn() {
        if (!this.state || !this.state.setpoints) return false;
        
        const { Light_Start_setpoint, Light_Shutdown_setpoint } = this.state.setpoints;
        if (!Light_Start_setpoint || !Light_Shutdown_setpoint) return false;

        const now = new Date();
        const [startHour, startMinute] = Light_Start_setpoint.split(':').map(Number);
        const [stopHour, stopMinute] = Light_Shutdown_setpoint.split(':').map(Number);

        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const startMinutes = startHour * 60 + startMinute;
        const stopMinutes = stopHour * 60 + stopMinute;

        if (startMinutes < stopMinutes) {
            // Normal case: start time is before stop time
            return currentMinutes >= startMinutes && currentMinutes < stopMinutes;
        } else {
            // Overnight case: start time is after stop time
            return currentMinutes >= startMinutes || currentMinutes < stopMinutes;
        }
    }
}

module.exports = new ControlLogic();
