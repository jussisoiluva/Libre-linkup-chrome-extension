import { log, displayDebugInfo } from './utils.js';

// Cache DOM elements
const elements = {
  refreshButton: document.getElementById('refreshButton'),
  loginForm: document.getElementById('loginForm'),
  glucoseData: document.getElementById('glucoseData'),
  credentialsForm: document.getElementById('credentialsForm'),
  debugInfo: document.getElementById('debugInfo'),
  glucoseLevelElement: document.getElementById('glucoseLevel'),
  regionSelect: document.getElementById('region'),
  lowThresholdInput: document.getElementById('lowThreshold'),
  highThresholdInput: document.getElementById('highThreshold'),
  time: document.getElementById('time')
};

// Initialize the popup
document.addEventListener('DOMContentLoaded', init);

async function init() {
  elements.refreshButton.addEventListener('click', manualRefresh);
  elements.loginForm.addEventListener('submit', handleCredentialsSubmit);

  const credentials = await getCachedCredentials();
  checkCredentialsAndInitUI(credentials);
}

// Get stored credentials from local and session storage
async function getCachedCredentials() {
  const local = await chrome.storage.local.get(['email', 'region', 'lowThreshold', 'highThreshold']);
  const session = await chrome.storage.session.get(['password']);
  return { ...local, ...session };
}

// Check if credentials are set and show appropriate UI
function checkCredentialsAndInitUI(credentials) {
  if (areCredentialsValid(credentials)) {
    showGlucoseData();
    manualRefresh();
  } else {
    showCredentialsForm();
  }
  displayDebugInfo();
}

// Check if all required credentials are set
function areCredentialsValid(credentials) {
  return credentials.email && credentials.password && credentials.region && 
         credentials.lowThreshold && credentials.highThreshold;
}

// Show glucose data view
function showGlucoseData() {
  elements.glucoseData.classList.remove('hidden');
  elements.credentialsForm.classList.add('hidden');
  log('Showing glucose data view');
}

// Show credentials form
function showCredentialsForm() {
  elements.glucoseData.classList.add('hidden');
  elements.credentialsForm.classList.remove('hidden');
  log('Showing credentials form');
}

// Handle credentials form submission
async function handleCredentialsSubmit(event) {
  event.preventDefault();
  const credentials = getFormData();
  await setCredentials(credentials);
}

// Input validation function
function validateInput(input) {
  // Remove any HTML tags and trim whitespace
  return input.replace(/(<([^>]+)>)/gi, "").trim();
}

// Get form data with input validation
function getFormData() {
  return {
    email: validateInput(document.getElementById('email').value),
    password: document.getElementById('password').value, // Don't validate password to preserve special characters
    region: validateInput(elements.regionSelect.value),
    lowThreshold: parseInt(validateInput(elements.lowThresholdInput.value)),
    highThreshold: parseInt(validateInput(elements.highThresholdInput.value))
  };
}

// Save credentials by sending them to background script
async function setCredentials(credentials) {
  chrome.runtime.sendMessage({ action: 'setCredentials', credentials });
  checkCredentialsAndInitUI(credentials);
}

// Manually refresh glucose data
function manualRefresh() {
  elements.glucoseLevelElement.textContent = 'Loading...';
  log('Manually refreshing glucose level...');
  chrome.runtime.sendMessage({ action: 'manualUpdate' });
}

// Handle errors
export function handleError(error) {
  console.error('Error:', error);
  elements.glucoseLevelElement.textContent = `An error occurred. Please try again.`;
  log(`Error occurred: ${error.message}`);

  if (error.message === 'Credentials or settings not set') {
    showCredentialsForm();
  }
}

// Listen for glucose updates from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateGlucose') {
    if (request.data.error) {
      elements.glucoseLevelElement.textContent = request.data.error;
    } else {
      elements.glucoseLevelElement.textContent = `Current Glucose Level: ${request.data.Value} mg/dL`;
      elements.time.textContent = `Time: ${request.data.Timestamp}`;
      log(`Glucose level: ${request.data.Value} mg/dL and Time ${request.data.Timestamp}`);
    }
  }
});