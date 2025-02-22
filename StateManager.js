// lib/StateManager.js
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state.json');

/**
 * Loads the state from the state.json file.
 * Assumes that the file always exists.
 * If reading fails, returns an empty state structure.
 */
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error loading state:', err);
    // Return an empty state structure to avoid legacy default values.
    return { buttons: {}, setpoints: {}, fanCurves: {} };
  }
}

/**
 * Saves the state to the state.json file.
 */
function saveState(stateObj) {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(stateObj, null, 2)
    );
    return true;
  } catch (err) {
    console.error('Error saving state:', err);
    return false;
  }
}

module.exports = {
  loadState,
  saveState
};