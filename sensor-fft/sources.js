// Signal sources. Each exposes: channels, units, dbLabel, sampleRate, total
// (samples received so far), start(), stop(), poll() (once per frame) and
// read(n, channel, out) which fills `out` with the newest n samples and
// returns how many are real (the rest is zero padding at the start).

class RingBuffer {
  constructor(capacity, channels) {
    this.cap = capacity;
    this.data = Array.from({ length: channels }, () => new Float32Array(capacity));
    this.total = 0;
  }
  push(values) {
    const i = this.total % this.cap;
    for (let c = 0; c < this.data.length; c++) this.data[c][i] = values[c];
    this.total++;
  }
  read(n, ch, out) {
    const avail = Math.min(this.total, this.cap, n);
    const pad = n - avail, d = this.data[ch];
    out.fill(0, 0, pad);
    const start = this.total - avail;
    for (let i = 0; i < avail; i++) out[pad + i] = d[(start + i) % this.cap];
    return avail;
  }
}

// Estimates the real sampling rate of event-driven sensors from timestamps.
class RateMeter {
  constructor(size = 256) { this.t = new Float64Array(size); this.n = 0; }
  tick(ms) { this.t[this.n % this.t.length] = ms; this.n++; }
  get hz() {
    const len = Math.min(this.n, this.t.length);
    if (len < 8) return 0;
    const last = this.t[(this.n - 1) % this.t.length];
    const first = this.t[(this.n - len) % this.t.length];
    return last > first ? ((len - 1) * 1000) / (last - first) : 0;
  }
}

// ---------------------------------------------------------------- microphone
export class MicSource {
  constructor() {
    this.label = 'Microphone';
    this.channels = ['Microphone'];
    this.units = 'full scale';
    this.dbLabel = 'dBFS';
    this.maxN = 32768;
    this.defaultN = 4096;
    this.isAudio = true;
  }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access needs a secure (https://) page.');
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx(); // created inside the tap so iOS allows it to run
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = this.maxN;
    this.an.smoothingTimeConstant = 0;
    src.connect(this.an);
    this.buf = new Float32Array(this.maxN);
    this.backend = 'Web Audio';
  }
  get sampleRate() { return this.ctx?.sampleRate || 48000; }
  get total() { return Math.floor((this.ctx?.currentTime || 0) * this.sampleRate); }
  poll() { this.an?.getFloatTimeDomainData(this.buf); }
  read(n, ch, out) { out.set(this.buf.subarray(this.maxN - n)); return n; }
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }
}

// ------------------------------------------------------------ motion sensors
const GENERIC = {
  accel: 'Accelerometer',
  linacc: 'LinearAccelerationSensor',
  gyro: 'Gyroscope',
  mag: 'Magnetometer',
};
const LABELS = {
  accel: 'Accelerometer (with gravity)',
  linacc: 'Linear acceleration (gravity removed)',
  gyro: 'Gyroscope',
  mag: 'Magnetometer',
};

export class MotionSource {
  constructor(kind) {
    this.kind = kind;
    this.label = LABELS[kind];
    this.channels = ['X', 'Y', 'Z', 'Magnitude |v|'];
    this.units = kind === 'gyro' ? 'rad/s' : kind === 'mag' ? 'µT' : 'm/s²';
    this.dbLabel = `dB re 1 ${this.units}`;
    this.maxN = 16384;
    this.defaultN = 256;
    this.buf = new RingBuffer(this.maxN, 4);
    this.rate = new RateMeter();
  }
  get sampleRate() { return this.rate.hz || 60; }
  get total() { return this.buf.total; }
  poll() {}
  read(n, ch, out) { return this.buf.read(n, ch, out); }

  push(x, y, z, ms) {
    this.buf.push([x, y, z, Math.hypot(x, y, z)]);
    this.rate.tick(ms);
  }

  async start() {
    const k = this.kind;
    const Ctor = window[GENERIC[k]];
    // Android Chrome: the Generic Sensor API allows higher sample rates.
    // iOS has no such constructors, so its permission prompt stays the first
    // thing awaited after the tap (Safari requires that).
    if (Ctor) {
      try { return await this.startGeneric(Ctor); } catch (e) {
        if (k === 'mag') throw e;
        console.warn('Generic Sensor API failed, falling back to devicemotion', e);
      }
    } else if (k === 'mag') {
      throw new Error('This browser does not expose the magnetometer. On Android Chrome, enable ' +
        'chrome://flags/#enable-generic-sensor-extra-classes.');
    }
    if (typeof DeviceMotionEvent?.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion sensor permission was denied.');
    }
    return this.startDeviceMotion();
  }

  startGeneric(Ctor) {
    return new Promise((resolve, reject) => {
      let s;
      try { s = new Ctor({ frequency: 200 }); } catch (e) { reject(e); return; }
      let first = true;
      const timer = setTimeout(() => { s.stop(); reject(new Error('The sensor sent no readings.')); }, 3000);
      s.onreading = () => {
        this.push(s.x, s.y, s.z, s.timestamp ?? performance.now());
        if (first) {
          first = false; clearTimeout(timer);
          this.sensor = s; this.backend = 'Generic Sensor API';
          resolve();
        }
      };
      s.onerror = (e) => {
        clearTimeout(timer); s.stop();
        if (first) reject(e.error || new Error('Sensor error'));
      };
      s.start();
    });
  }

  startDeviceMotion() {
    if (!('DeviceMotionEvent' in window)) throw new Error('This browser has no motion sensor support.');
    const k = this.kind;
    if (k === 'gyro') { this.units = 'deg/s'; this.dbLabel = 'dB re 1 deg/s'; }
    return new Promise((resolve, reject) => {
      let first = true;
      const timer = setTimeout(() => {
        window.removeEventListener('devicemotion', this.onMotion);
        reject(new Error('No motion data arrived. Is this a phone or tablet?'));
      }, 3000);
      this.onMotion = (e) => {
        let x, y, z;
        if (k === 'gyro') {
          const r = e.rotationRate; if (!r || r.alpha == null) return;
          x = r.beta; y = r.gamma; z = r.alpha; // rotation about the X, Y and Z axes
        } else {
          const v = k === 'accel' ? e.accelerationIncludingGravity : e.acceleration;
          if (!v || v.x == null) return;
          x = v.x; y = v.y; z = v.z;
        }
        this.push(x, y, z, e.timeStamp);
        if (first) { first = false; clearTimeout(timer); this.backend = 'devicemotion event'; resolve(); }
      };
      window.addEventListener('devicemotion', this.onMotion);
    });
  }

  stop() {
    this.sensor?.stop();
    if (this.onMotion) window.removeEventListener('devicemotion', this.onMotion);
  }
}

// ------------------------------------------------------------- test signal
export class TestSource {
  constructor() {
    this.label = 'Test signal (no sensor)';
    this.channels = ['Tones 50 Hz + 123.4 Hz + noise', 'Chirp 5 → 450 Hz every 10 s', 'Beating 200 Hz + 210 Hz'];
    this.units = 'units';
    this.dbLabel = 'dB re 1';
    this.maxN = 16384;
    this.defaultN = 1024;
    this.fs = 1000;
    this.buf = new RingBuffer(this.maxN, 3);
  }
  get sampleRate() { return this.fs; }
  get total() { return this.buf.total; }
  start() { this.t0 = performance.now(); this.backend = 'synthetic'; }
  stop() {}
  read(n, ch, out) { return this.buf.read(n, ch, out); }
  poll() {
    const target = Math.floor(((performance.now() - this.t0) / 1000) * this.fs);
    if (target - this.buf.total > this.maxN) this.buf.total = target - this.maxN;
    const TAU = 2 * Math.PI, T = 10, f0 = 5, f1 = 450;
    while (this.buf.total < target) {
      const t = this.buf.total / this.fs;
      const noise = Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(TAU * Math.random());
      const a = Math.sin(TAU * 50 * t) + 0.5 * Math.sin(TAU * 123.4 * t) + 0.05 * noise;
      const tc = t % T;
      const b = Math.sin(TAU * (f0 * tc + ((f1 - f0) * tc * tc) / (2 * T)));
      const c = 0.5 * Math.sin(TAU * 200 * t) + 0.5 * Math.sin(TAU * 210 * t);
      this.buf.push([a, b, c]);
    }
  }
}

export const SOURCES = {
  mic: () => new MicSource(),
  accel: () => new MotionSource('accel'),
  linacc: () => new MotionSource('linacc'),
  gyro: () => new MotionSource('gyro'),
  mag: () => new MotionSource('mag'),
  test: () => new TestSource(),
};
