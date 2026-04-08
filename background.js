import { log } from './utils.js';

// API endpoints for different regions
const API_ENDPOINTS = {
  EU: {
    auth: 'https://api-eu.libreview.io/llu/auth/login',
    data: 'https://api-eu.libreview.io/llu/connections',
  },
  US: {
    auth: 'https://api.libreview.io/llu/auth/login',
    data: 'https://api.libreview.io/llu/connections',
    
  }
};

// Create an alarm to update glucose levels every minute
chrome.alarms.create('updateGlucose', { periodInMinutes: 1 });

// Listen for the alarm and update glucose level
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'updateGlucose') {
    updateGlucoseLevel();
  }
});

// Main function to update glucose level
async function updateGlucoseLevel() {
  log('Updating glucose level', 'background');
  
  try {
    const credentials = await getCachedCredentials();
    if (!areCredentialsValid(credentials)) {
      log('Credentials or settings not set', 'background');
      return;
    }

    const token = await authenticateUser(credentials);
    const data = await fetchGlucoseData(token, credentials.region);
    
    log(`Glucose level updated: ${data.Value} mg/dL`, 'background');
    
    updateBadge(data.Value, credentials.lowThreshold, credentials.highThreshold);
    notifyPopup(data);
  } catch (error) {
    console.log('An error occurred:' + error);
    updateBadgeError();
    // Don't expose detailed error messages to the user
    notifyPopup({ error: 'An error occurred while updating glucose level.' });
  }
}

// Get stored credentials from local and session storage
async function getCachedCredentials() {
  const local = await chrome.storage.local.get(['email', 'region', 'lowThreshold', 'highThreshold']);
  const session = await chrome.storage.session.get(['password']);
  return { ...local, ...session };
}

// Check if all required credentials are set
function areCredentialsValid(credentials) {
  return credentials.email && credentials.password && credentials.region && 
         credentials.lowThreshold && credentials.highThreshold;
}

// Authenticate user and get token
async function authenticateUser({ email, password, region }) {
  const response = await fetch(API_ENDPOINTS[region].auth, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'product': 'llu.android',
      'version': '4.12.0'
    },
    body: JSON.stringify({ email, password })
  });
  const raw = await response.text();

  if (!response.ok) {
    console.error("Request failed:", response.status, response.statusText);
    console.error("Raw response:", raw);
    throw new Error(`Auth failed: ${response.status}`);
  }
  
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse JSON");
    console.error("Raw response was:", raw);
    throw e;
  }
  
  console.log("Parsed JSON:", data);
  return data;
}

async function computeSHA256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
  return hashHex;
}


// Fetch glucose data using the authentication token
async function fetchGlucoseData(token, region) {
  log('ID:' +  await token.data.user.id);

  log('HASH ID:' +  await computeSHA256(token.data.user.id));
  const account = await computeSHA256(token.data.user.id);
  const auth = await token.data.authTicket.token;
  const response = await fetch(API_ENDPOINTS[region].data, {
    headers: {
      'Authorization': `Bearer ${auth}`,
      'product': 'llu.android',
      'version': '4.16.0',
      'Account-Id' : `${account}`

    }
  });
  
if (!response.ok) {
  log('ERROR HERE: ' + JSON.stringify({
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    url: response.url
  }, null, 2));
  
  // If you want to include the response body (requires async/await)
  const errorBody = await response.text();
  log('ERROR BODY: ' + errorBody);
  throw new Error(`Failed to fetch glucose data: ${response.status} ${response.statusText}`);
}

  const data = await response.json();
  log('DOING GLUCOSE DATA ' + response.status + ' >>> ' + JSON.stringify(data));
  if (!data.data || data.data.length === 0 || !data.data[0].glucoseMeasurement) {
    throw new Error('No glucose data available in the response');
  }

  return data.data[0].glucoseMeasurement;
}

// Update extension badge with glucose level and color
function updateBadge(level, lowThreshold, highThreshold) {
  chrome.action.setBadgeText({text: String(level).slice(0, 4)});
  const color = level < lowThreshold ? '#ff0000' : level > highThreshold ? '#ff9900' : '#00ff00';
  chrome.action.setBadgeBackgroundColor({color});
}

// Update badge to show error
function updateBadgeError() {
  chrome.action.setBadgeText({text: 'ERR'});
  chrome.action.setBadgeBackgroundColor({color: '#ff0000'});
}

// Send updated glucose data to popup
function notifyPopup(data) {
  chrome.runtime.sendMessage({ action: 'updateGlucose', data })
    .catch(() => log("Popup is not open. Can't send update.", 'background'));
}

// Listen for manual update requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'manualUpdate') {
    updateGlucoseLevel();
  } else if (request.action === 'setCredentials') {
    setCredentials(request.credentials);
  }
});

// Set credentials in storage
async function setCredentials({ email, password, region, lowThreshold, highThreshold }) {
  // Store non-sensitive data in local storage
  await chrome.storage.local.set({ email, region, lowThreshold, highThreshold });
  
  // Store sensitive data in session storage
  await chrome.storage.session.set({ password });
  
  log('Credentials and settings saved');
}

async function clearCredentials() {
  await chrome.storage.local.remove(['email', 'region', 'lowThreshold', 'highThreshold']);
  await chrome.storage.session.clear();
}