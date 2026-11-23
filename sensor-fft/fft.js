// Radix-2 FFT, window functions and spectrum helpers. No dependencies.

export class FFT {
  constructor(n) {
    if (!Number.isInteger(Math.log2(n)) || n < 2) throw new Error('FFT size must be a power of 2');
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / n); // forward transform
    }
  }

  // In-place forward transform of (re, im).
  transform(re, im) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const a = start + k, b = a + half;
          const wr = cs[tw], wi = sn[tw];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

export const WINDOWS = {
  hann: 'Hann',
  hamming: 'Hamming',
  blackman: 'Blackman',
  flattop: 'Flat top (accurate amplitude)',
  rect: 'Rectangular (none)',
};

// Periodic windows (best for spectral analysis).
export function makeWindow(type, n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    switch (type) {
      case 'hann': w[i] = 0.5 - 0.5 * Math.cos(x); break;
      case 'hamming': w[i] = 0.54 - 0.46 * Math.cos(x); break;
      case 'blackman': w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x); break;
      case 'flattop':
        w[i] = 0.21557895 - 0.41663158 * Math.cos(x) + 0.277263158 * Math.cos(2 * x)
          - 0.083578947 * Math.cos(3 * x) + 0.006947368 * Math.cos(4 * x);
        break;
      default: w[i] = 1;
    }
  }
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) { sum += w[i]; sumSq += w[i] * w[i]; }
  return { w, sum, enbw: (n * sumSq) / (sum * sum) };
}

// Turns n time samples into a single-sided amplitude spectrum (n/2 + 1 bins),
// scaled so that a sine of amplitude A shows a peak of about A.
export class SpectrumAnalyzer {
  constructor(n, windowType) {
    this.n = n;
    this.fft = new FFT(n);
    this.win = makeWindow(windowType, n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.amp = new Float32Array(n / 2 + 1);
  }

  compute(samples) {
    const { n, re, im, amp } = this;
    const w = this.win.w;
    for (let i = 0; i < n; i++) { re[i] = samples[i] * w[i]; im[i] = 0; }
    this.fft.transform(re, im);
    const scale = 1 / this.win.sum;
    for (let k = 0; k <= n / 2; k++) {
      const m = Math.hypot(re[k], im[k]) * scale;
      amp[k] = k === 0 || k === n / 2 ? m : 2 * m;
    }
    return amp;
  }
}

// Local maxima in a dB spectrum, refined by parabolic interpolation.
export function findPeaks(db, binHz, { floor, count = 5, skipDC = true, minSep = 3 } = {}) {
  const cands = [];
  for (let k = skipDC ? 2 : 1; k < db.length - 1; k++) {
    const b = db[k];
    if (b < floor || b < db[k - 1] || b < db[k + 1]) continue;
    if (k >= 2 && b < db[k - 2]) continue;
    if (k + 2 < db.length && b < db[k + 2]) continue;
    const a = db[k - 1], c = db[k + 1];
    const den = a - 2 * b + c;
    const p = den === 0 ? 0 : (0.5 * (a - c)) / den;
    cands.push({ bin: k, freq: (k + p) * binHz, db: b - 0.25 * (a - c) * p });
  }
  cands.sort((x, y) => y.db - x.db);
  const out = [];
  for (const c of cands) {
    if (out.every((o) => Math.abs(o.bin - c.bin) >= minSep)) out.push(c);
    if (out.length >= count) break;
  }
  return out;
}
