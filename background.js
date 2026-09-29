import { log, toMgDl, MGDL_PER_MMOL } from './utils.js';

const GLOBAL_HOST = 'api.libreview.io';
const DATA_HEADERS = {
  'product': 'llu.android',
  'version': '4.16.0',
};
// Refresh the session token slightly before it actually expires.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

chrome.alarms.create('updateGlucose', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'updateGlucose') updateGlucoseLevel();
});

async function updateGlucoseLevel() {
  log('Updating glucose level', 'background');

  try {
    const credentials = await getCachedCredentials();
    if (!areCredentialsValid(credentials)) {
      log('Credentials or settings not set', 'background');
      return;
    }

    const session = await getOrRefreshSession(credentials);
    const { currentReading, graphData } = await fetchConnectionData(session);

    log(`Glucose level updated: ${currentReading.Value} mg/dL`, 'background');

    const { unit } = await chrome.storage.local.get(['unit']);
    updateBadge(currentReading.Value, credentials.lowThreshold, credentials.highThreshold, unit);

    await chrome.storage.local.set({ cachedReading: currentReading, graphData });

    notifyPopup({ current: currentReading, graphData });
  } catch (error) {
    console.error('An error occurred:', error);
    updateBadgeError();
    notifyPopup({ error: error.message || 'An error occurred while updating glucose level.' });
  }
}

async function getCachedCredentials() {
  const local = await chrome.storage.local.get(['email', 'lowThreshold', 'highThreshold']);
  const session = await chrome.storage.session.get(['password']);
  return { ...local, ...session };
}

function areCredentialsValid(credentials) {
  return !!(credentials.email && credentials.password &&
    credentials.lowThreshold && credentials.highThreshold);
}

// ─── Auth session ───────────────────────────────────────────────────────────
// LibreLinkUp's login endpoint hands back a bearer token that stays valid for
// months (per community reverse-engineering notes: gist.github.com/khskekec/
// 6c13ba01b10d3018d816706a32ae8ab2). Re-authenticating on every 1-minute poll
// isn't just wasteful, the same notes describe accounts getting temporarily
// locked out (HTTP 429/430) from doing exactly that — so we cache the token
// and only log in again once it's actually close to expiring or rejected.

function hostFor(region) {
  return region ? `api-${region}.libreview.io` : GLOBAL_HOST;
}

async function getOrRefreshSession(credentials) {
  const cached = await chrome.storage.session.get(['authTicket', 'accountId', 'region']);

  if (cached.authTicket && cached.authTicket.expires * 1000 - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return { token: cached.authTicket.token, accountId: cached.accountId, region: cached.region };
  }

  return login(credentials);
}

async function login({ email, password }) {
  // No region is known yet (or the previous one stopped working): start at
  // the global host, which redirects us to the account's actual region.
  const { region: lastRegion } = await chrome.storage.session.get(['region']);

  let region = lastRegion;
  let result = await postLogin(hostFor(region), email, password);

  if (result.data?.redirect && result.data?.region) {
    region = result.data.region;
    result = await postLogin(hostFor(region), email, password);
  }

  const token = result.data?.authTicket?.token;
  const expires = result.data?.authTicket?.expires;
  if (!token) {
    throw new Error('Login succeeded but no session token was returned. Please try again.');
  }

  const accountId = await computeSHA256(result.data.user.id);

  await chrome.storage.session.set({ authTicket: { token, expires }, accountId, region });

  return { token, accountId, region };
}

async function postLogin(host, email, password) {
  const response = await fetch(`https://${host}/llu/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...DATA_HEADERS,
    },
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 401) {
    throw new Error('Invalid email or password.');
  }
  if (response.status === 429 || response.status === 430) {
    const body = await safeJson(response).catch(() => null);
    const lockout = body?.data?.lockout;
    throw new Error(lockout
      ? `Too many login attempts. Try again in ${lockout}s.`
      : 'Too many login attempts. Please wait a few minutes and try again.');
  }
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  return safeJson(response);
}

async function safeJson(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse response:', raw);
    throw new Error('Unexpected response from server.');
  }
}

async function computeSHA256(text) {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Connection + graph data ────────────────────────────────────────────────

async function fetchConnectionData(session) {
  const host = hostFor(session.region);
  const headers = {
    'Authorization': `Bearer ${session.token}`,
    'Account-Id': session.accountId,
    ...DATA_HEADERS,
  };

  const connRes = await fetch(`https://${host}/llu/connections`, { headers });

  if (connRes.status === 401) {
    // Cached token was rejected (revoked/expired early) — drop it so the
    // next poll performs a fresh login instead of repeating the same call.
    await chrome.storage.session.remove('authTicket');
    throw new Error('Session expired, will retry on next refresh.');
  }
  if (!connRes.ok) {
    const body = await connRes.text();
    log(`Connections error ${connRes.status}: ${body}`, 'background');
    throw new Error(`Connections failed: ${connRes.status}`);
  }

  const connData = await connRes.json();
  if (!connData.data?.length || !connData.data[0].glucoseMeasurement) {
    throw new Error('No glucose data available for this account.');
  }

  const connection = connData.data[0];
  // Normalize to mg/dL here so every downstream consumer (badge coloring,
  // thresholds, the popup's unit toggle) can rely on `.Value` always being
  // mg/dL, regardless of what unit this LibreView account displays in.
  const currentReading = { ...connection.glucoseMeasurement, Value: toMgDl(connection.glucoseMeasurement) };
  const patientId = connection.patientId;

  const graphData = await fetchGraphData(host, patientId, headers);

  return { currentReading, graphData };
}

async function fetchGraphData(host, patientId, headers) {
  const res = await fetch(`https://${host}/llu/connections/${patientId}/graph`, { headers });

  if (!res.ok) {
    log(`Graph data error ${res.status} — skipping`, 'background');
    return [];
  }

  const json = await res.json();
  const graphData = json.data?.graphData ?? [];
  return graphData.map(point => ({ ...point, Value: toMgDl(point) }));
}

function updateBadge(level, lowThreshold, highThreshold, unit) {
  // `level`/`lowThreshold`/`highThreshold` are always mg/dL — only the
  // displayed badge text changes with the user's chosen unit.
  const text = unit === 'mmol/L' ? (level / MGDL_PER_MMOL).toFixed(1) : String(Math.round(level));
  chrome.action.setBadgeText({ text: text.slice(0, 4) });
  const color = level < lowThreshold ? '#ff0000' : level > highThreshold ? '#ff9900' : '#00cc55';
  chrome.action.setBadgeBackgroundColor({ color });
}

function updateBadgeError() {
  chrome.action.setBadgeText({ text: 'ERR' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });
}

function notifyPopup(data) {
  chrome.runtime.sendMessage({ action: 'updateGlucose', data })
    .catch(() => log("Popup not open, skipping message.", 'background'));
}

// Re-render the badge as soon as the unit preference changes, instead of
// waiting for the next 1-minute poll to pick it up.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.unit) return;

  const { cachedReading, lowThreshold, highThreshold } = await chrome.storage.local.get(
    ['cachedReading', 'lowThreshold', 'highThreshold']
  );
  if (cachedReading) updateBadge(cachedReading.Value, lowThreshold, highThreshold, changes.unit.newValue);
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'manualUpdate') {
    updateGlucoseLevel();
  } else if (request.action === 'setCredentials') {
    setCredentials(request.credentials);
  } else if (request.action === 'clearCredentials') {
    clearCredentials();
  }
});

async function setCredentials({ email, password, lowThreshold, highThreshold }) {
  await chrome.storage.local.set({ email, lowThreshold, highThreshold });
  await chrome.storage.session.set({ password });
  // Credentials changed, so any cached token/region belonged to the old
  // login — drop them and let the next poll re-detect region from scratch.
  await chrome.storage.session.remove(['authTicket', 'accountId', 'region']);
  log('Credentials and settings saved', 'background');
  updateGlucoseLevel();
}

async function clearCredentials() {
  await chrome.storage.local.remove(['email', 'lowThreshold', 'highThreshold', 'graphData', 'cachedReading']);
  await chrome.storage.session.clear();
  chrome.action.setBadgeText({ text: '' });
}
