import { log, displayDebugInfo, MGDL_PER_MMOL } from './utils.js';

const elements = {
  refreshButton: document.getElementById('refreshButton'),
  logoutButton: document.getElementById('logoutButton'),
  loginForm: document.getElementById('loginForm'),
  loginError: document.getElementById('loginError'),
  glucoseData: document.getElementById('glucoseData'),
  credentialsForm: document.getElementById('credentialsForm'),
  debugInfo: document.getElementById('debugInfo'),
  glucoseLevelElement: document.getElementById('glucoseLevel'),
  trendArrow: document.getElementById('trendArrow'),
  lowThresholdInput: document.getElementById('lowThreshold'),
  highThresholdInput: document.getElementById('highThreshold'),
  unitSelect: document.getElementById('unitSelect'),
  unitMgButton: document.getElementById('unitMgButton'),
  unitMmolButton: document.getElementById('unitMmolButton'),
  time: document.getElementById('time'),
  chartLabel: document.getElementById('chartLabel'),
  chartContainer: document.getElementById('chartContainer'),
  chartTooltip: document.getElementById('chartTooltip'),
  glucoseChart: document.getElementById('glucoseChart'),
};

// Thresholds and readings from the API are always mg/dL — `unit` only
// controls how values are *displayed*, converted on the fly.
let thresholds = { low: 70, high: 180 };
let unit = 'mg/dL';
// LibreLinkUp's graph endpoint doesn't hand back more than ~12h of history
// regardless of what's requested, so there's no "24h" option to offer.
const CHART_RANGE_HOURS = 12;
let lastReading = null;
let lastGraphData = null;

// Set by drawGlucoseChart on every draw so the hover handler can map a mouse
// position back to the nearest data point without recomputing the chart's
// time/value → pixel scaling itself.
let chartLayout = null;

const mgToMmol = mg => mg / MGDL_PER_MMOL;
const mmolToMg = mmol => mmol * MGDL_PER_MMOL;

function formatGlucose(mgValue) {
  return unit === 'mmol/L'
    ? `${mgToMmol(mgValue).toFixed(1)} mmol/L`
    : `${Math.round(mgValue)} mg/dL`;
}

function formatGlucoseTick(mgValue) {
  return unit === 'mmol/L' ? mgToMmol(mgValue).toFixed(1) : String(Math.round(mgValue));
}

// Rounds a raw step (range / desired tick count) to a "nice" 1/2/5×10ⁿ value,
// e.g. 3.2 → 5, 0.7 → 1, 22 → 20 — the standard trick for readable axis ticks.
function niceStep(range, targetTicks) {
  if (!isFinite(range) || range <= 0) return 1;
  const rawStep = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const niceResidual = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return niceResidual * magnitude;
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  elements.refreshButton.addEventListener('click', manualRefresh);
  elements.logoutButton.addEventListener('click', handleLogout);
  elements.loginForm.addEventListener('submit', handleCredentialsSubmit);
  elements.unitSelect?.addEventListener('change', () => {
    unit = elements.unitSelect.value;
    updateThresholdPlaceholders();
  });
  elements.unitMgButton?.addEventListener('click', () => setUnit('mg/dL'));
  elements.unitMmolButton?.addEventListener('click', () => setUnit('mmol/L'));
  elements.glucoseChart.addEventListener('mousemove', handleChartHover);
  elements.glucoseChart.addEventListener('mouseleave', handleChartLeave);

  const { unit: storedUnit } = await chrome.storage.local.get(['unit']);
  unit = storedUnit || 'mg/dL';
  updateUnitToggleUI();
  updateThresholdPlaceholders();

  const credentials = await getCachedCredentials();
  if (credentials.lowThreshold) thresholds.low = parseInt(credentials.lowThreshold);
  if (credentials.highThreshold) thresholds.high = parseInt(credentials.highThreshold);

  checkCredentialsAndInitUI(credentials);

  // Show cached data immediately while fresh data loads
  const cached = await chrome.storage.local.get(['graphData', 'cachedReading']);
  if (cached.cachedReading && cached.graphData) {
    renderGlucose(cached.cachedReading, cached.graphData);
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

function checkCredentialsAndInitUI(credentials) {
  if (areCredentialsValid(credentials)) {
    showGlucoseData();
    manualRefresh();
  } else {
    showCredentialsForm();
  }
  displayDebugInfo();
}

function showGlucoseData() {
  elements.glucoseData.classList.remove('hidden');
  elements.credentialsForm.classList.add('hidden');
}

function showCredentialsForm() {
  elements.glucoseData.classList.add('hidden');
  elements.credentialsForm.classList.remove('hidden');
}

async function handleCredentialsSubmit(event) {
  event.preventDefault();
  unit = elements.unitSelect.value;
  await chrome.storage.local.set({ unit });
  const credentials = getFormData();
  thresholds.low = credentials.lowThreshold;
  thresholds.high = credentials.highThreshold;
  setLoginPending(true);
  chrome.runtime.sendMessage({ action: 'setCredentials', credentials });
}

function validateInput(input) {
  return input.replace(/(<([^>]+)>)/gi, '').trim();
}

// Thresholds are entered in whatever `unit` is currently selected, but are
// always sent to background.js (and stored) as mg/dL, since that's the unit
// the LibreLinkUp API itself reports readings in.
function getFormData() {
  const low = parseFloat(validateInput(elements.lowThresholdInput.value));
  const high = parseFloat(validateInput(elements.highThresholdInput.value));
  return {
    email: validateInput(document.getElementById('email').value),
    password: document.getElementById('password').value,
    lowThreshold: Math.round(unit === 'mmol/L' ? mmolToMg(low) : low),
    highThreshold: Math.round(unit === 'mmol/L' ? mmolToMg(high) : high),
  };
}

function setUnit(newUnit) {
  unit = newUnit;
  chrome.storage.local.set({ unit });
  updateUnitToggleUI();
  updateThresholdPlaceholders();
  if (lastReading) renderGlucose(lastReading, lastGraphData);
}

function updateUnitToggleUI() {
  elements.unitMgButton?.classList.toggle('active', unit === 'mg/dL');
  elements.unitMmolButton?.classList.toggle('active', unit === 'mmol/L');
  if (elements.unitSelect) elements.unitSelect.value = unit;
}

function updateThresholdPlaceholders() {
  elements.lowThresholdInput.placeholder = unit === 'mmol/L' ? 'Low (e.g. 3.9)' : 'Low (e.g. 70)';
  elements.highThresholdInput.placeholder = unit === 'mmol/L' ? 'High (e.g. 10.0)' : 'High (e.g. 180)';
}

function setLoginPending(pending) {
  const submitButton = elements.loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = pending;
  submitButton.textContent = pending ? 'Signing in…' : 'Sign In';
  hideLoginError();
}

function showLoginError(message) {
  elements.loginError.textContent = message;
  elements.loginError.classList.remove('hidden');
}

function hideLoginError() {
  elements.loginError.textContent = '';
  elements.loginError.classList.add('hidden');
}

function handleLogout() {
  chrome.runtime.sendMessage({ action: 'clearCredentials' });
  elements.loginForm.reset();
  showCredentialsForm();
}

function manualRefresh() {
  elements.glucoseLevelElement.textContent = 'Loading...';
  if (elements.trendArrow) elements.trendArrow.textContent = '';
  log('Manually refreshing glucose level...');
  chrome.runtime.sendMessage({ action: 'manualUpdate' });
}

// The region isn't known until the region-detecting login succeeds (see
// background.js), so a bad email/password surfaces here as this exact
// message — route the user back to the sign-in form to fix it instead of
// leaving them stuck on a permanently-erroring reading.
function handleGlucoseError(message) {
  log(`Error: ${message}`);

  const isAuthError = message === 'Invalid email or password.';
  const onLoginScreen = !elements.credentialsForm.classList.contains('hidden');

  if (isAuthError || onLoginScreen) {
    setLoginPending(false);
    showCredentialsForm();
    showLoginError(message);
    return;
  }

  elements.glucoseLevelElement.textContent = message;
  elements.glucoseLevelElement.style.color = '#ff3333';
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderGlucose(reading, graphData) {
  lastReading = reading;
  lastGraphData = graphData;

  updateUnitToggleUI();

  const value = reading.Value;
  elements.glucoseLevelElement.textContent = formatGlucose(value);
  elements.glucoseLevelElement.style.color = valueColor(value);

  if (elements.trendArrow) {
    elements.trendArrow.textContent = trendSymbol(reading.TrendArrow);
  }

  const ts = formatTimestamp(reading.Timestamp);
  elements.time.textContent = `Updated: ${ts}`;

  drawGlucoseChart(graphData, reading, thresholds.low, thresholds.high);

  log(`Glucose: ${formatGlucose(value)} at ${ts}`);
}

function valueColor(value) {
  if (value < thresholds.low) return '#ff3333';
  if (value > thresholds.high) return '#ff9900';
  return '#00cc55';
}

// LibreLinkUp's TrendArrow: 0 NotDetermined, 1 FallingQuickly, 2 Falling,
// 3 Stable, 4 Rising, 5 RisingQuickly.
function trendSymbol(arrow) {
  return ['', '↓↓', '↓', '→', '↑', '↑↑'][arrow] ?? '';
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Daily Chart ────────────────────────────────────────────────────────────

function chartRangeLabel(points) {
  if (points.length < 2) return '';
  const start = new Date(points[0].t);
  const end = new Date(points[points.length - 1].t);
  const fmt = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return start.toDateString() === end.toDateString()
    ? `Today's Glucose · ${fmt(start)}`
    : `Glucose · ${fmt(start)} – ${fmt(end)}`;
}

function drawGlucoseChart(rawData, currentReading, low, high, hoverIndex = null) {
  const canvas = elements.glucoseChart;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Combine graph data with the current (most recent) reading
  const allData = [...(rawData || [])];
  if (currentReading) allData.push(currentReading);

  const cutoff = Date.now() - CHART_RANGE_HOURS * 60 * 60 * 1000;
  const points = allData
    .map(r => ({ t: new Date(r.Timestamp).getTime(), v: Number(r.Value) }))
    .filter(p => !isNaN(p.t) && p.v > 0)
    .filter(p => p.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .filter((p, i, arr) => i === 0 || p.t !== arr[i - 1].t); // deduplicate

  if (elements.chartLabel) elements.chartLabel.textContent = chartRangeLabel(points);

  ctx.clearRect(0, 0, W, H);

  if (points.length < 2) {
    chartLayout = null;
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', W / 2, H / 2);
    return;
  }

  const pad = { t: 8, r: 10, b: 22, l: 36 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  const minT = points[0].t;
  const maxT = points[points.length - 1].t;

  const vals = points.map(p => p.v);
  const dataMin = Math.min(...vals);
  const dataMax = Math.max(...vals);
  const minV = Math.min(dataMin, low) - 10;
  const maxV = Math.max(dataMax, high) + 10;

  const tx = t => pad.l + ((t - minT) / (maxT - minT || 1)) * pw;
  const ty = v => pad.t + (1 - (v - minV) / (maxV - minV)) * ph;

  chartLayout = { points, tx, ty };

  const yLow = ty(low);
  const yHigh = ty(high);
  const plotTop = pad.t;
  const plotBot = pad.t + ph;

  // Background zones
  ctx.fillStyle = 'rgba(255,150,0,0.10)';
  ctx.fillRect(pad.l, plotTop, pw, Math.max(0, yHigh - plotTop));

  ctx.fillStyle = 'rgba(0,200,80,0.07)';
  ctx.fillRect(pad.l, yHigh, pw, Math.max(0, yLow - yHigh));

  ctx.fillStyle = 'rgba(255,50,50,0.10)';
  ctx.fillRect(pad.l, yLow, pw, Math.max(0, plotBot - yLow));

  // Threshold dashed lines
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);

  ctx.strokeStyle = 'rgba(255,100,100,0.55)';
  ctx.beginPath();
  ctx.moveTo(pad.l, yLow); ctx.lineTo(pad.l + pw, yLow);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,160,0,0.55)';
  ctx.beginPath();
  ctx.moveTo(pad.l, yHigh); ctx.lineTo(pad.l + pw, yHigh);
  ctx.stroke();

  ctx.setLineDash([]);

  // Glucose line
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffc300';
  ctx.lineJoin = 'round';
  points.forEach((p, i) => {
    const x = tx(p.t), y = ty(p.v);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Latest value dot
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(tx(last.t), ty(last.v), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = last.v < low ? '#ff3333' : last.v > high ? '#ff9900' : '#00cc55';
  ctx.fill();

  // Y-axis labels
  ctx.fillStyle = '#888';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';

  if (unit === 'mmol/L') {
    // Picking the step in mg/dL and converting it to mmol/L for display
    // gives ugly numbers like "8.9" (18.0182 doesn't divide evenly into a
    // round mg/dL step) — instead pick a round step directly in mmol/L
    // (1/2/5/10…) and convert *that* back to mg/dL for pixel placement.
    const dispMin = mgToMmol(minV);
    const dispMax = mgToMmol(maxV);
    const step = niceStep(dispMax - dispMin, 4);
    const start = Math.ceil(dispMin / step) * step;
    for (let dv = start; dv <= dispMax; dv += step) {
      const y = ty(mmolToMg(dv));
      if (y >= plotTop && y <= plotBot) {
        ctx.fillText(step < 1 ? dv.toFixed(1) : String(Math.round(dv)), pad.l - 3, y + 3);
      }
    }
  } else {
    const yStep = Math.ceil((maxV - minV) / 4 / 10) * 10;
    const yStart = Math.ceil(minV / yStep) * yStep;
    for (let v = yStart; v <= maxV; v += yStep) {
      const y = ty(v);
      if (y >= plotTop && y <= plotBot) {
        ctx.fillText(formatGlucoseTick(v), pad.l - 3, y + 3);
      }
    }
  }

  // X-axis time labels
  ctx.textAlign = 'center';
  const xCount = 4;
  for (let i = 0; i <= xCount; i++) {
    const t = minT + (maxT - minT) * (i / xCount);
    const d = new Date(t);
    const label = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    ctx.fillText(label, tx(t), H - 5);
  }

  // Plot border
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, pw, ph);

  // Hover guide line + highlighted point
  if (hoverIndex !== null && points[hoverIndex]) {
    const hp = points[hoverIndex];
    const hx = tx(hp.t);
    const hy = ty(hp.v);

    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, plotTop);
    ctx.lineTo(hx, plotBot);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#333';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}

function handleChartHover(event) {
  if (!chartLayout || !lastReading) return;

  const canvas = elements.glucoseChart;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mouseX = (event.clientX - rect.left) * scaleX;

  const { points, tx, ty } = chartLayout;
  let nearestIndex = 0;
  let nearestDist = Infinity;
  points.forEach((p, i) => {
    const dist = Math.abs(tx(p.t) - mouseX);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  });

  drawGlucoseChart(lastGraphData, lastReading, thresholds.low, thresholds.high, nearestIndex);

  const hovered = chartLayout.points[nearestIndex];
  const tooltipX = chartLayout.tx(hovered.t) / scaleX;
  const tooltipY = chartLayout.ty(hovered.v) / scaleY;

  elements.chartTooltip.textContent = `${formatGlucose(hovered.v)} · ${formatTimestamp(hovered.t)}`;
  elements.chartTooltip.classList.remove('hidden');

  const containerWidth = elements.chartContainer.clientWidth;
  const tooltipWidth = elements.chartTooltip.offsetWidth;
  const clampedX = Math.max(tooltipWidth / 2 + 2, Math.min(containerWidth - tooltipWidth / 2 - 2, tooltipX));

  elements.chartTooltip.style.left = `${clampedX}px`;
  elements.chartTooltip.style.top = `${tooltipY}px`;
}

function handleChartLeave() {
  elements.chartTooltip.classList.add('hidden');
  if (lastReading) drawGlucoseChart(lastGraphData, lastReading, thresholds.low, thresholds.high);
}

// ─── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== 'updateGlucose') return;

  if (request.data.error) {
    handleGlucoseError(request.data.error);
  } else {
    setLoginPending(false);
    showGlucoseData();
    renderGlucose(request.data.current, request.data.graphData);
  }
});
