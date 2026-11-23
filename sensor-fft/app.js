import { SpectrumAnalyzer, WINDOWS, findPeaks } from './fft.js';
import { SOURCES } from './sources.js';

const $ = (id) => document.getElementById(id);
const ui = {
  start: $('start'), freeze: $('freeze'), source: $('source'), channel: $('channel'), size: $('size'),
  window: $('window'), scale: $('scale'), fmax: $('fmax'), avg: $('avg'), range: $('range'), dc: $('dc'),
  msg: $('msg'), wave: $('wave'), spec: $('spec'), sgram: $('sgram'), sgramAxis: $('sgramAxis'),
};

const COLUMNS_PER_SECOND = 30; // spectrogram scroll speed
const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();
const C = { grid: color('--grid'), line: color('--line'), muted: color('--muted'), text: color('--text'),
  accent: color('--accent'), accent2: color('--accent2'), panel: color('--panel') };

const state = {
  source: null, running: false, frozen: false,
  N: 4096, windowType: 'hann', avg: 0.5, range: 90, log: false, removeDC: true, fmaxUser: 0, channel: 0,
};

let analyzer, timeBuf, avgAmp, specDb, peaks = [];
let lastTotal = -1, lastColumnTotal = 0, dbTop = 0, cursorX = null, wakeLock = null;

// ------------------------------------------------------------------ setup UI
for (const [k, v] of Object.entries(WINDOWS)) ui.window.add(new Option(v, k));

function fillSizes(maxN, pick) {
  ui.size.innerHTML = '';
  for (let n = 64; n <= maxN; n *= 2) ui.size.add(new Option(String(n), String(n)));
  ui.size.value = String(pick);
}

function describeSource() {
  const src = SOURCES[ui.source.value]();
  ui.channel.innerHTML = '';
  src.channels.forEach((c, i) => ui.channel.add(new Option(c, String(i))));
  state.channel = 0;
  const motion = ['accel', 'linacc', 'gyro', 'mag'].includes(ui.source.value);
  ui.channel.value = motion ? '3' : '0';
  state.channel = Number(ui.channel.value);
  fillSizes(src.maxN, src.defaultN);
  state.N = src.defaultN;
  ui.scale.value = src.isAudio ? 'log' : 'lin';
  state.log = ui.scale.value === 'log';
  ui.range.value = src.isAudio ? '100' : '80';
  state.range = Number(ui.range.value);
  syncLabels();
  return src;
}

function syncLabels() {
  $('avgVal').textContent = `(${Number(ui.avg.value).toFixed(2)})`;
  $('rangeVal').textContent = `(${ui.range.value} dB)`;
}

function rebuildAnalyzer() {
  analyzer = new SpectrumAnalyzer(state.N, state.windowType);
  timeBuf = new Float32Array(state.N);
  avgAmp = new Float32Array(state.N / 2 + 1);
  specDb = new Float32Array(state.N / 2 + 1).fill(-200);
  lastTotal = -1;
  peaks = [];
}

function showError(e) {
  ui.msg.textContent = e ? (e.message || String(e)) : '';
  ui.msg.classList.toggle('show', !!e);
}

// ------------------------------------------------------------- start / stop
async function start() {
  showError(null);
  const src = SOURCES[ui.source.value]();
  try {
    await src.start();
  } catch (e) {
    src.stop?.();
    showError(e);
    return;
  }
  state.source = src;
  state.running = true;
  ui.start.textContent = 'Stop';
  ui.start.classList.add('running');
  $('backend').textContent = src.backend || '—';
  $('specUnits').textContent = src.dbLabel;
  $('noteWrap').hidden = !src.isAudio;
  rebuildAnalyzer();
  clearSpectrogram();
  requestWakeLock();
}

function stop() {
  state.source?.stop();
  state.running = false;
  ui.start.textContent = 'Start';
  ui.start.classList.remove('running');
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (state.running && document.visibilityState === 'visible') requestWakeLock();
});

ui.start.addEventListener('click', () => (state.running ? stop() : start()));
ui.freeze.addEventListener('click', () => {
  state.frozen = !state.frozen;
  ui.freeze.setAttribute('aria-pressed', String(state.frozen));
});
ui.source.addEventListener('change', () => {
  const wasRunning = state.running;
  if (wasRunning) stop();
  describeSource();
  rebuildAnalyzer();
  if (wasRunning) start();
});
ui.channel.addEventListener('change', () => { state.channel = Number(ui.channel.value); rebuildAnalyzer(); clearSpectrogram(); });
ui.size.addEventListener('change', () => { state.N = Number(ui.size.value); rebuildAnalyzer(); clearSpectrogram(); });
ui.window.addEventListener('change', () => { state.windowType = ui.window.value; rebuildAnalyzer(); });
ui.scale.addEventListener('change', () => { state.log = ui.scale.value === 'log'; clearSpectrogram(); render(); });
ui.fmax.addEventListener('change', () => { state.fmaxUser = Number(ui.fmax.value) || 0; clearSpectrogram(); render(); });
ui.avg.addEventListener('input', () => { state.avg = Number(ui.avg.value); syncLabels(); });
ui.range.addEventListener('input', () => { state.range = Number(ui.range.value); syncLabels(); render(); });
ui.dc.addEventListener('change', () => { state.removeDC = ui.dc.checked; });
$('clear').addEventListener('click', clearSpectrogram);
$('csv').addEventListener('click', exportSpectrum);
$('raw').addEventListener('click', exportWaveform);

// --------------------------------------------------------- frequency mapping
function fs() { return state.source?.sampleRate || 1000; }
function binHz() { return fs() / state.N; }
function fMax() {
  const nyq = fs() / 2;
  return state.fmaxUser > 0 ? Math.min(state.fmaxUser, nyq) : nyq;
}
function fMin() { return state.log ? Math.max(binHz(), fMax() / 10000) : 0; }
function freqToFrac(f) {
  const lo = fMin(), hi = fMax();
  if (!state.log) return f / hi;
  return Math.log(Math.max(f, lo) / lo) / Math.log(hi / lo);
}
function fracToFreq(x) {
  const lo = fMin(), hi = fMax();
  return state.log ? lo * Math.pow(hi / lo, x) : x * hi;
}

function niceStep(span, target) {
  const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function freqTicks() {
  const lo = fMin(), hi = fMax(), ticks = [];
  if (!state.log) {
    const step = niceStep(hi, 6);
    for (let f = 0; f <= hi + 1e-9; f += step) ticks.push(f);
  } else {
    for (let d = Math.pow(10, Math.floor(Math.log10(lo))); d <= hi; d *= 10) {
      for (const m of [1, 2, 5]) { const f = d * m; if (f >= lo && f <= hi) ticks.push(f); }
    }
  }
  return ticks;
}
const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : f >= 10 ? `${+f.toFixed(1)}` : `${+f.toFixed(2)}`);
const fmtNum = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));

// ------------------------------------------------------------ canvas sizing
const dpr = () => window.devicePixelRatio || 1;
function fit(canvas) {
  const w = Math.round(canvas.clientWidth * dpr()), h = Math.round(canvas.clientHeight * dpr());
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
  return false;
}
new ResizeObserver(() => {
  fit(ui.wave); fit(ui.spec); fit(ui.sgramAxis);
  if (fit(ui.sgram)) clearSpectrogram();
  render();
}).observe(document.body);

// ---------------------------------------------------------------- main loop
function frame() {
  requestAnimationFrame(frame);
  const src = state.source;
  if (!src || !state.running) return;
  src.poll();
  updateStats();
  if (state.frozen) return;
  const total = src.total;
  if (total === lastTotal) return;
  lastTotal = total;

  const valid = src.read(state.N, state.channel, timeBuf);
  if (state.removeDC && valid > 0) {
    let mean = 0;
    for (let i = state.N - valid; i < state.N; i++) mean += timeBuf[i];
    mean /= valid;
    for (let i = state.N - valid; i < state.N; i++) timeBuf[i] -= mean;
  }
  const amp = analyzer.compute(timeBuf);
  const a = state.avg;
  for (let k = 0; k < amp.length; k++) {
    avgAmp[k] = a * avgAmp[k] + (1 - a) * amp[k];
    specDb[k] = 20 * Math.log10(avgAmp[k] + 1e-12);
  }

  // Auto-range: jump up quickly, fall back slowly.
  let maxDb = -200;
  const kStart = state.removeDC ? 1 : 0;
  for (let k = kStart; k < specDb.length; k++) if (specDb[k] > maxDb) maxDb = specDb[k];
  const target = Math.ceil((maxDb + 5) / 10) * 10;
  dbTop = target > dbTop ? target : dbTop + (target - dbTop) * 0.02;

  peaks = findPeaks(specDb, binHz(), { floor: dbTop - state.range * 0.75, skipDC: state.removeDC });
  updatePeakReadout();

  const hop = Math.max(1, Math.round(fs() / COLUMNS_PER_SECOND));
  // Skip spectrogram columns while the buffer is still filling (zero padding
  // would smear energy across all frequencies).
  if (valid < state.N) lastColumnTotal = total;
  else if (total - lastColumnTotal >= hop) {
    // Several columns if we fell behind (e.g. tab in background), capped.
    const n = Math.min(Math.floor((total - lastColumnTotal) / hop), 8);
    for (let i = 0; i < n; i++) addSpectrogramColumn();
    lastColumnTotal = total;
  }
  render();
}
requestAnimationFrame(frame);

function updateStats() {
  const src = state.source, f = fs();
  $('fs').textContent = `${f.toFixed(f < 1000 ? 1 : 0)} Hz`;
  $('df').textContent = `${fmtNum(f / state.N)} Hz`;
  const t = state.N / f;
  $('tlen').textContent = t < 1 ? `${(t * 1000).toFixed(0)} ms` : `${t.toFixed(1)} s`;
  $('fill').textContent = `${Math.min(100, Math.round((src.total / state.N) * 100))}%`;
}

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function noteName(f) {
  const n = 12 * Math.log2(f / 440) + 69, r = Math.round(n);
  const cents = Math.round((n - r) * 100);
  return `${NOTES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}¢`;
}

function updatePeakReadout() {
  const src = state.source, p = peaks[0];
  $('dom').textContent = p ? `${fmtHz(p.freq)} Hz` : '—';
  $('period').textContent = p ? (1 / p.freq < 1 ? `${(1000 / p.freq).toFixed(2)} ms` : `${(1 / p.freq).toFixed(2)} s`) : '—';
  $('ampl').textContent = p ? `${fmtNum(Math.pow(10, p.db / 20))} ${src.units} (${p.db.toFixed(1)} dB)` : '—';
  if (src.isAudio) $('note').textContent = p && p.freq > 20 ? noteName(p.freq) : '—';
  const box = $('peaks');
  box.textContent = '';
  peaks.forEach((pk, i) => {
    const s = document.createElement('span');
    s.textContent = `${i + 1}: ${fmtHz(pk.freq)} Hz  ${pk.db.toFixed(1)} dB`;
    box.appendChild(s);
  });
}

// ----------------------------------------------------------------- drawing
function render() {
  if (!analyzer) return;
  drawWave();
  drawSpectrum();
  drawSpectrogramAxis();
}

function drawWave() {
  const c = ui.wave, g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!timeBuf) return;
  let lo = Infinity, hi = -Infinity;
  for (const v of timeBuf) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo) || hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  g.strokeStyle = C.grid; g.lineWidth = 1;
  const y0 = H - ((0 - lo) / (hi - lo)) * H;
  if (y0 > 0 && y0 < H) { g.beginPath(); g.moveTo(0, y0); g.lineTo(W, y0); g.stroke(); }
  g.strokeStyle = C.accent; g.lineWidth = 1.25 * dpr();
  g.beginPath();
  const n = timeBuf.length, step = Math.max(1, Math.floor(n / W / 2));
  for (let i = 0; i < n; i += step) {
    const x = (i / (n - 1)) * W, y = H - ((timeBuf[i] - lo) / (hi - lo)) * H;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  const units = state.source?.units || '';
  $('waveInfo').textContent = `${fmtNum(lo + pad)} … ${fmtNum(hi - pad)} ${units}`;
}

function drawSpectrum() {
  const c = ui.spec, g = c.getContext('2d'), W = c.width, H = c.height, d = dpr();
  g.clearRect(0, 0, W, H);
  const padL = 34 * d, padB = 18 * d, padT = 8 * d, pw = W - padL, ph = H - padB;
  const lo = dbTop - state.range;
  const yOf = (db) => ph - ((db - lo) / state.range) * (ph - padT);
  const xOf = (f) => padL + freqToFrac(f) * pw;

  g.font = `${10 * d}px system-ui, sans-serif`;
  g.fillStyle = C.muted; g.strokeStyle = C.grid; g.lineWidth = 1;
  g.textAlign = 'right'; g.textBaseline = 'middle';
  const dbStep = state.range > 80 ? 20 : 10;
  for (let db = Math.ceil(lo / dbStep) * dbStep; db <= dbTop; db += dbStep) {
    const y = yOf(db);
    g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
    g.fillText(String(Math.round(db)), padL - 4 * d, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const f of freqTicks()) {
    const x = xOf(f);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ph); g.stroke();
    g.fillText(fmtHz(f), Math.min(Math.max(x, padL + 10 * d), W - 12 * d), ph + 4 * d);
  }
  if (!specDb) return;

  // Spectrum line: per pixel column take the max over the bins it covers.
  const bh = binHz(), fmax = fMax();
  g.save();
  g.beginPath(); g.rect(padL, 0, pw, ph); g.clip();
  g.beginPath();
  let started = false;
  for (let px = 0; px <= pw; px += 1) {
    const f0 = fracToFreq(px / pw), f1 = fracToFreq((px + 1) / pw);
    if (f0 > fmax) break;
    let k0 = Math.round(f0 / bh), k1 = Math.max(k0, Math.round(f1 / bh));
    if (state.removeDC && k0 === 0) k0 = 1;
    k1 = Math.min(k1, specDb.length - 1);
    let m = -200;
    for (let k = k0; k <= k1; k++) if (specDb[k] > m) m = specDb[k];
    const y = yOf(m);
    started ? g.lineTo(padL + px, y) : (g.moveTo(padL + px, y), started = true);
  }
  g.lineTo(W, ph); g.lineTo(padL, ph); g.closePath();
  g.fillStyle = 'rgba(63,185,80,0.15)'; g.fill();
  g.strokeStyle = C.accent; g.lineWidth = 1.25 * d; g.stroke();
  g.restore();

  // Peak markers
  g.fillStyle = C.accent2; g.textAlign = 'center'; g.textBaseline = 'bottom';
  peaks.forEach((p, i) => {
    const x = xOf(p.freq), y = yOf(p.db);
    if (x < padL || x > W) return;
    g.beginPath(); g.moveTo(x, y - 2 * d); g.lineTo(x - 4 * d, y - 9 * d); g.lineTo(x + 4 * d, y - 9 * d); g.fill();
    if (i === 0) g.fillText(`${fmtHz(p.freq)} Hz`, Math.min(Math.max(x, padL + 24 * d), W - 24 * d), y - 11 * d);
  });

  // Tap cursor
  if (cursorX != null && cursorX >= padL) {
    const f = fracToFreq((cursorX - padL) / pw);
    const k = Math.min(specDb.length - 1, Math.round(f / bh));
    g.strokeStyle = C.text; g.setLineDash([4 * d, 4 * d]);
    g.beginPath(); g.moveTo(cursorX, 0); g.lineTo(cursorX, ph); g.stroke(); g.setLineDash([]);
    $('cursor').textContent = `${fmtHz(f)} Hz · ${specDb[k].toFixed(1)} dB`;
  }
}

function onPointer(e) {
  if (e.type === 'pointermove' && e.buttons === 0 && e.pointerType !== 'mouse') return;
  const r = ui.spec.getBoundingClientRect();
  cursorX = (e.clientX - r.left) * dpr();
  render();
}
ui.spec.addEventListener('pointerdown', onPointer);
ui.spec.addEventListener('pointermove', onPointer);
ui.spec.addEventListener('dblclick', () => { cursorX = null; $('cursor').textContent = ''; render(); });

// ------------------------------------------------------------- spectrogram
const LUT = (() => {
  const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1), j = Math.min(stops.length - 2, Math.floor(x)), t = x - j;
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = stops[j][ch] + (stops[j + 1][ch] - stops[j][ch]) * t;
  }
  return lut;
})();
let column = null;

function clearSpectrogram() {
  const c = ui.sgram, g = c.getContext('2d');
  g.fillStyle = 'rgb(0,0,4)'; g.fillRect(0, 0, c.width, c.height);
  column = null;
  drawSpectrogramAxis();
}

function addSpectrogramColumn() {
  const c = ui.sgram, g = c.getContext('2d'), W = c.width, H = c.height;
  if (!W || !H) return;
  if (!column || column.height !== H) column = g.createImageData(1, H);
  g.drawImage(c, -1, 0);
  const bh = binHz(), lo = dbTop - state.range, data = column.data;
  for (let y = 0; y < H; y++) {
    const fHi = fracToFreq(1 - y / H), fLo = fracToFreq(1 - (y + 1) / H);
    let k0 = Math.max(state.removeDC ? 1 : 0, Math.round(fLo / bh));
    const k1 = Math.min(specDb.length - 1, Math.max(k0, Math.round(fHi / bh)));
    let m = -200;
    for (let k = k0; k <= k1; k++) if (specDb[k] > m) m = specDb[k];
    const v = Math.max(0, Math.min(255, Math.round(((m - lo) / state.range) * 255)));
    data[y * 4] = LUT[v * 3]; data[y * 4 + 1] = LUT[v * 3 + 1]; data[y * 4 + 2] = LUT[v * 3 + 2]; data[y * 4 + 3] = 255;
  }
  g.putImageData(column, W - 1, 0);
}

function drawSpectrogramAxis() {
  const c = ui.sgramAxis, g = c.getContext('2d'), W = c.width, H = c.height, d = dpr();
  g.clearRect(0, 0, W, H);
  g.font = `${10 * d}px system-ui, sans-serif`;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const f of freqTicks()) {
    const y = H - freqToFrac(f) * H;
    if (y < 6 * d || y > H - 6 * d) continue;
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, y, 6 * d, 1);
    const label = `${fmtHz(f)} Hz`;
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(8 * d, y - 7 * d, g.measureText(label).width + 6 * d, 14 * d);
    g.fillStyle = '#fff'; g.fillText(label, 11 * d, y);
  }
  const secs = W / COLUMNS_PER_SECOND;
  g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.fillText(`← ${secs.toFixed(0)} s`, W - 4 * d, H - 4 * d);
}

// ------------------------------------------------------------------ export
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function exportSpectrum() {
  if (!specDb) return;
  const src = state.source, bh = binHz();
  const rows = [`frequency_hz,amplitude_${(src?.units || 'units').replace(/[^\w/]/g, '')},db`];
  for (let k = 0; k < specDb.length; k++) rows.push(`${(k * bh).toFixed(6)},${avgAmp[k].toExponential(6)},${specDb[k].toFixed(3)}`);
  download(`spectrum-${ui.source.value}-${stamp()}.csv`, rows.join('\n'));
}

function exportWaveform() {
  if (!timeBuf) return;
  const f = fs(), rows = ['time_s,value'];
  for (let i = 0; i < timeBuf.length; i++) rows.push(`${(i / f).toFixed(6)},${timeBuf[i]}`);
  download(`waveform-${ui.source.value}-${stamp()}.csv`, rows.join('\n'));
}

// ------------------------------------------------------------------- init
describeSource();
state.windowType = ui.window.value;
rebuildAnalyzer();
clearSpectrogram();
