// Log messages to console and debug info element
export function log(message, context = 'popup') {
  console.log(message);
  // Check if the document is available before trying to access DOM elements
  if (typeof document !== 'undefined' && context === 'popup') {
    const debugInfo = document.getElementById('debugInfo');
    if (debugInfo) {
      debugInfo.append(message, document.createElement('br'));
    }
  } else {
    // Log the message without using the document object
    console.log(`Unable to log to popup: ${message}`);
  }
}

export const MGDL_PER_MMOL = 18.0182;

// LibreLinkUp's `glucoseMeasurement.Value` is reported in whichever unit the
// LibreView account itself is configured for (mg/dL or mmol/L, indicated by
// `GlucoseUnits`: 0 or 1) — it is NOT always mg/dL. `ValueInMgPerDl` is the
// one field that's always mg/dL regardless of the account's display unit,
// so normalize to that wherever a reading comes in from the API.
export function toMgDl(measurement) {
  if (typeof measurement.ValueInMgPerDl === 'number') return measurement.ValueInMgPerDl;
  return measurement.GlucoseUnits === 1 ? measurement.Value * MGDL_PER_MMOL : measurement.Value;
}

// Display debug information including stored items and extension details
export async function displayDebugInfo() {
  const items = await chrome.storage.local.get(null);
  log('Stored items: ' + JSON.stringify(items, (key, value) => key === 'password' ? '[REDACTED]' : value));
  log('Extension version: ' + chrome.runtime.getManifest().version);
  log('User agent: ' + navigator.userAgent);
}