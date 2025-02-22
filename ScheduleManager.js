const EventEmitter = require('events');

class ScheduleManager extends EventEmitter {
    constructor(controlLogic) {
        super();
        this.controlLogic = controlLogic;

        // Schedule arrays
        this.lightSchedule = [];      // Array of { time: Date, action: boolean }
        this.irrigationSchedule = []; // Array of { time: Date, params: {duration, interval, count} }

        // Schedule checker interval
        this.scheduleChecker = null;
    }

    init() {
        // Recalculate schedule tables based on the current state
        this.recalculateSchedules();

        // Start schedule checker
        if (this.scheduleChecker) clearInterval(this.scheduleChecker);
        this.scheduleChecker = setInterval(() => {
            this.checkSchedules();
        }, 10000); // 10 seconds

        console.log('[ScheduleManager] init OK');
    }

    recalculateSchedules() {
        this.lightSchedule = this.calculateLightSchedule();
        this.irrigationSchedule = this.calculateIrrigationSchedule();
        console.log('[ScheduleManager] Schedules recalculated');
    }

    recalculateIrrigationSchedule() {
        this.irrigationSchedule = this.calculateIrrigationSchedule();
        console.log('[ScheduleManager] Irrigation schedule recalculated');
    }

    calculateLightSchedule() {
        const schedule = [];
        if (!this.controlLogic.state || !this.controlLogic.state.setpoints) return schedule;
        const { Light_Start_setpoint, Light_Shutdown_setpoint } = this.controlLogic.state.setpoints;
        if (!Light_Start_setpoint || !Light_Shutdown_setpoint) return schedule;

        const now = new Date();
        const [startHour, startMinute] = Light_Start_setpoint.split(':').map(Number);
        const [stopHour, stopMinute] = Light_Shutdown_setpoint.split(':').map(Number);

        const todayStart = new Date(now); todayStart.setHours(startHour, startMinute, 0, 0);
        const todayStop = new Date(now); todayStop.setHours(stopHour, stopMinute, 0, 0);

        // Schedule next ON event:
        if (todayStart > now) {
            schedule.push({ time: todayStart, action: true });
        } else {
            const tomorrowStart = new Date(todayStart);
            tomorrowStart.setDate(tomorrowStart.getDate() + 1);
            schedule.push({ time: tomorrowStart, action: true });
        }

        // Schedule next OFF event:
        if (todayStop > now) {
            schedule.push({ time: todayStop, action: false });
        } else {
            const tomorrowStop = new Date(todayStop);
            tomorrowStop.setDate(tomorrowStop.getDate() + 1);
            schedule.push({ time: tomorrowStop, action: false });
        }

        // Sort events by time
        schedule.sort((a, b) => a.time - b.time);
        return schedule;
    }

    calculateIrrigationSchedule() {
        const schedule = [];
        if (!this.controlLogic.state || !this.controlLogic.state.setpoints || !this.controlLogic.state.buttons) return schedule;

        const now = new Date();
        const lightStartStr = this.controlLogic.state.setpoints.Light_Start_setpoint;
        if (!lightStartStr) return schedule;
        const [startHour] = lightStartStr.split(':').map(Number);

        // Get step quantization (1/1 to 6/1)
        const stepQuantize = parseInt(this.controlLogic.state.setpoints.Step_Duration_setpoint) || 1;
        const quantizeValues = {
            1: [0],                                    // 1/1: début du step
            2: [0, 30],                               // 2/1: toutes les 30min
            3: [0, 20, 40],                           // 3/1: toutes les 20min
            4: [0, 15, 30, 45],                       // 4/1: toutes les 15min
            5: [0, 12, 24, 36, 48],                   // 5/1: toutes les 12min
            6: [0, 10, 20, 30, 40, 50]                // 6/1: toutes les 10min
        };

        const stepDivisions = quantizeValues[stepQuantize] || [0];

        // 24-hour step sequencer, synced to light cycle
        for (let step = 1; step <= 24; step++) {
            const btnId = `Btn_Step_${step}_0`;
            if (!this.controlLogic.state.buttons[btnId]) continue;

            // Calculate base hour from light cycle start
            let stepHour = (startHour + step - 1) % 24;

            // Create events for each division of the step
            stepDivisions.forEach(minutes => {
                const eventTime = new Date(now);
                eventTime.setHours(stepHour, minutes, 0, 0);

                // Schedule for next day if time has passed
                if (eventTime < now) {
                    eventTime.setDate(eventTime.getDate() + 1);
                }

                schedule.push({
                    time: eventTime,
                    type: 'irrigation',
                    step: step,
                    division: minutes,
                    params: {
                        duration: parseInt(this.controlLogic.state.setpoints.Pulse_Duration_setpoint) || 10,
                        interval: parseInt(this.controlLogic.state.setpoints.Pulse_Interval_setpoint) || 60,
                        count: parseInt(this.controlLogic.state.setpoints.Event_Count_setpoint) || 1
                    }
                });

                console.log(`[INFO] Step ${step} Division ${minutes}min scheduled: ${eventTime.toLocaleTimeString()} - ${this.controlLogic.state.setpoints.Event_Count_setpoint} pulses`);
            });
        }

        schedule.sort((a, b) => a.time - b.time);
        return schedule;
    }

    checkSchedules() {
        const now = new Date();
        const logPrefix = '[INFO]';

        // Check light events
        while (this.lightSchedule.length > 0 && this.lightSchedule[0].time <= now) {
            const event = this.lightSchedule.shift();
            // Remove manual override when schedule kicks in
            if (event.action !== this.controlLogic.lastHardwareCmd['light']) {
                this.controlLogic.manualOverride['light'] = false;
                this.controlLogic.setHardwareState('light', event.action);
                console.log(`${logPrefix} Light schedule enforced: turning ${event.action ? 'ON' : 'OFF'} at ${now.toLocaleString()}`);
            }
        }

        // Check sequencer steps
        while (this.irrigationSchedule.length > 0 && this.irrigationSchedule[0].time <= now) {
            const event = this.irrigationSchedule.shift();
            if (!this.controlLogic.manualOverride['irrigation']) {
                console.log(`${logPrefix} Triggering Step ${event.step} at ${now.toLocaleString()}`);
                this.executeIrrigationSequence(event.params.duration, event.params.interval, event.params.count);
            }
        }

        // Recalculate schedules if needed
        if (this.lightSchedule.length === 0) {
            this.lightSchedule = this.calculateLightSchedule();
        }
        if (this.irrigationSchedule.length === 0) {
            this.irrigationSchedule = this.calculateIrrigationSchedule();
        }
    }

    executeIrrigationSequence(duration, interval, count) {
        let pulseNumber = 0;
        let timeoutRefs = [];  // Pour stocker les références des timeouts
        let sequenceActive = true;

        // Émettre l'état initial
        this.emit('irrigation_sequence_start', {
            total: count,
            current: 0,
            duration,
            interval
        });

        const executePulse = () => {
            if (!sequenceActive) return;  // Check if sequence was cancelled

            if (pulseNumber < count) {
                this.controlLogic.setHardwareState('irrigation', true);

                // Store timeout reference
                const offTimeout = setTimeout(() => {
                    if (!sequenceActive) return;
                    this.controlLogic.setHardwareState('irrigation', false);
                    pulseNumber++;

                    // Émettre la progression
                    this.emit('irrigation_sequence_progress', {
                        total: count,
                        current: pulseNumber,
                        remaining: count - pulseNumber
                    });

                    if (pulseNumber < count) {
                        const nextPulseTimeout = setTimeout(executePulse, interval * 1000);
                        timeoutRefs.push(nextPulseTimeout);
                    } else {
                        // Séquence terminée normalement
                        this.emit('irrigation_sequence_complete', {
                            total: count,
                            duration,
                            interval
                        });
                    }
                }, duration * 1000);

                timeoutRefs.push(offTimeout);
            }
        };

        // Fonction de nettoyage
        const cleanup = () => {
            sequenceActive = false;
            timeoutRefs.forEach(ref => clearTimeout(ref));
            timeoutRefs = [];
            this.controlLogic.setHardwareState('irrigation', false);
            this.emit('irrigation_sequence_cleanup');
        };

        // Stocker la fonction cleanup pour pouvoir l'appeler de l'extérieur
        this.currentIrrigationCleanup = cleanup;

        console.log(`[INFO] Starting irrigation sequence: ${count} pulses of ${duration}s every ${interval}s`);
        executePulse();

        // Retourner l'ID de séquence pour le suivi
        return Date.now();
    }

    cleanup() {
        if (this.scheduleChecker) {
            clearInterval(this.scheduleChecker);
            this.scheduleChecker = null;
        }
    }
}

module.exports = ScheduleManager;