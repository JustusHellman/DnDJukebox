/**
 * Measures how a track feels, from its audio alone (no packages; the same code runs in a browser).
 *
 *   analyze(samples, sampleRate) → {
 *     intensity,  0–100: how much "oomph" it has. Mostly the attacks in the high frequencies
 *                 (drums, cymbals, brass hits), how full the spectrum is (orchestra vs. solo lute)
 *                 and how little of it is quiet.
 *     attack,     median high-frequency attack strength (drums/brass: 20+, solo instruments: < 5)
 *     fullness,   0–1 share of the spectrum in use (full orchestra ≈ 0.4+, solo ≈ 0.1)
 *     quiet,      0–1 share of the track well below its normal level
 *     intro,      seconds before the track reaches its normal level ("the hit")
 *     curve,      loudness every 4 s, 0–9, as a string (for drawing / reviewing)
 *   }
 *
 * `samples` is mono audio (Float32Array, -1…1). Calibrated at 22050 Hz.
 * The weights were tuned on ~400 tracks: lute ballads land around 20, battle themes 80–100.
 */
export const ANALYSIS_VERSION = 2;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export function intensityOf({ attack, fullness, quiet }) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  return Math.round(100 * (0.55 * clamp(attack / 35) + 0.25 * clamp((fullness - 0.08) / 0.5) + 0.2 * clamp(1 - quiet * 3)));
}

export function analyze(samples, sr) {
  const N = 1024, HOP = 512, H = N / 2, binHz = sr / N;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float32Array(N), im = new Float32Array(N);
  let prev = new Float32Array(H);
  const frames = Math.max(0, Math.floor((samples.length - N) / HOP));
  const rms = new Float32Array(frames), hflux = new Float32Array(frames), band = new Float32Array(frames);
  const kHi = Math.round(5000 / binHz), kA = Math.round(100 / binHz), kB = Math.round(8000 / binHz);

  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const s = samples[o + i];
      e += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    const mag = new Float32Array(H);
    let hf = 0, mx = 0;
    for (let k = 1; k < H; k++) {
      const h = Math.hypot(re[k], im[k]);
      if (h > mx) mx = h;
      const m = Math.log1p(10 * h);
      mag[k] = m;
      if (k > kHi) {
        const d = m - prev[k];
        if (d > 0) hf += d;
      }
    }
    let b = 0;
    const th = mx * 0.01;
    for (let k = kA; k <= kB; k++) if (Math.hypot(re[k], im[k]) > th) b++;
    band[f] = b / (kB - kA + 1);
    hflux[f] = hf;
    prev = mag;
  }

  const fps = sr / HOP, seconds = Math.floor(frames / fps), db = [];
  for (let s = 0; s < seconds; s++) {
    let e = 0, c = 0;
    for (let f = Math.floor(s * fps); f < Math.floor((s + 1) * fps) && f < frames; f++) {
      e += rms[f] * rms[f];
      c++;
    }
    db.push(10 * Math.log10(e / Math.max(1, c) + 1e-10));
  }
  const loud = pct(db, 0.8);
  const quiet = db.length ? db.filter((d) => d < loud - 12).length / db.length : 0;

  // The hit: first moment a 4 s stretch is within 6 dB of the normal level.
  let intro = 0;
  for (let s = 0; s + 4 <= db.length; s++) {
    if ((db[s] + db[s + 1] + db[s + 2] + db[s + 3]) / 4 >= loud - 6) {
      intro = s;
      break;
    }
  }

  const gate = Math.pow(10, (loud - 20) / 20);
  const sel = (a) => Array.from(a).filter((_, i) => rms[i] > gate);
  const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
  const attack = r(pct(sel(hflux), 0.5));
  const fullness = r(pct(sel(band), 0.5), 2);
  const curve = [];
  for (let s = 0; s < db.length; s += 4) curve.push(Math.max(0, Math.min(9, Math.round((db[s] - (loud - 27)) / 3))));
  return { v: ANALYSIS_VERSION, intensity: intensityOf({ attack, fullness, quiet }), attack, fullness, quiet: r(quiet, 2), intro, curve: curve.join('') };
}
