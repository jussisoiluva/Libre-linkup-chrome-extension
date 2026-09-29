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

// Display debug information including stored items and extension details
export async function displayDebugInfo() {
  const items = await chrome.storage.local.get(null);
  log('Stored items: ' + JSON.stringify(items, (key, value) => key === 'password' ? '[REDACTED]' : value));
  log('Extension version: ' + chrome.runtime.getManifest().version);
  log('User agent: ' + navigator.userAgent);
}