// Pure DSP helpers that work on Float32Arrays, so they run in Node tests too.

export function toMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  }
  return out;
}

export function peak(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p;
}

function rmsWindows(samples, win) {
  const count = Math.ceil(samples.length / win);
  const out = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0;
    const end = Math.min(samples.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) sum += samples[i] * samples[i];
    out[w] = Math.sqrt(sum / Math.max(1, end - w * win));
  }
  return out;
}

/**
 * Find the word in a recording and cut the silence around it.
 * Starts at the loudest 10 ms window and grows outwards while sound keeps
 * coming back within `maxGap` seconds, so a stray click far away from the
 * word doesn't count, but the short pause inside "o-kay" does.
 */
export function trimSilence(samples, sampleRate, opts = {}) {
  const {
    windowSec = 0.01,
    maxGap = 0.22,
    padBefore = 0.015,
    padAfter = 0.06,
    fadeIn = 0.004,
    fadeOut = 0.03,
    maxLength = 2.0,
    relThreshold = 0.08,
    minThreshold = 0.003,
  } = opts;

  const win = Math.max(1, Math.round(windowSec * sampleRate));
  const rms = rmsWindows(samples, win);
  let loudest = 0;
  for (let i = 1; i < rms.length; i++) if (rms[i] > rms[loudest]) loudest = i;
  const top = rms[loudest] || 0;

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const threshold = Math.min(top * 0.3, Math.max(noiseFloor * 2.5, top * relThreshold, minThreshold));

  if (top < minThreshold) {
    return { samples: new Float32Array(0), start: 0, end: 0, threshold, silent: true };
  }

  const gapWindows = Math.round(maxGap / windowSec);
  let first = loudest;
  let last = loudest;
  for (let i = loudest, quiet = 0; i >= 0; i--) {
    if (rms[i] >= threshold) {
      first = i;
      quiet = 0;
    } else if (++quiet > gapWindows) break;
  }
  for (let i = loudest, quiet = 0; i < rms.length; i++) {
    if (rms[i] >= threshold) {
      last = i;
      quiet = 0;
    } else if (++quiet > gapWindows) break;
  }

  let start = Math.max(0, first * win - Math.round(padBefore * sampleRate));
  let end = Math.min(samples.length, (last + 1) * win + Math.round(padAfter * sampleRate));
  end = Math.min(end, start + Math.round(maxLength * sampleRate));

  const out = samples.slice(start, end);
  const fi = Math.min(out.length, Math.round(fadeIn * sampleRate));
  const fo = Math.min(out.length, Math.round(fadeOut * sampleRate));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;

  return { samples: out, start, end, threshold, silent: false };
}

export function normalize(samples, target = 0.89) {
  const p = peak(samples);
  if (p === 0) return samples;
  const g = target / p;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return out;
}

// YIN pitch estimate for a single frame. Returns { freq, clarity } or null.
function yinFrame(frame, sampleRate, minFreq, maxFreq, threshold) {
  const half = Math.floor(frame.length / 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(half - 1, Math.ceil(sampleRate / minFreq));
  const diff = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const d = frame[i] - frame[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }
  // cumulative mean normalized difference
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running ? (diff[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;
  // parabolic interpolation around the dip
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const denom = a + c - 2 * b;
    if (denom !== 0) better = tau + (a - c) / (2 * denom);
  }
  return { freq: sampleRate / better, clarity: 1 - cmnd[tau] };
}

/**
 * Estimate the pitch of a voiced sound. Runs YIN over the louder frames and
 * takes the median, which shrugs off the odd octave error on a consonant.
 */
export function detectPitch(samples, sampleRate, opts = {}) {
  const { minFreq = 65, maxFreq = 1000, threshold = 0.15 } = opts;
  const frameSize = sampleRate > 60000 ? 4096 : 2048;
  const hop = frameSize / 4;
  if (samples.length < frameSize) return null;

  const energies = [];
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + frameSize; i++) sum += samples[i] * samples[i];
    energies.push({ start, rms: Math.sqrt(sum / frameSize) });
  }
  const maxRms = Math.max(...energies.map((e) => e.rms));
  const results = [];
  for (const { start, rms } of energies) {
    if (rms < maxRms * 0.3) continue;
    const r = yinFrame(samples.subarray(start, start + frameSize), sampleRate, minFreq, maxFreq, threshold);
    if (r) results.push(r);
  }
  const loudFrames = energies.filter((e) => e.rms >= maxRms * 0.3).length;
  if (!results.length || results.length < Math.max(1, loudFrames * 0.3)) return null;

  const freqs = results.map((r) => r.freq).sort((a, b) => a - b);
  const median = freqs[Math.floor(freqs.length / 2)];
  const clarity = results.reduce((s, r) => s + r.clarity, 0) / results.length;
  return { freq: median, clarity, voicedFrames: results.length, frames: loudFrames };
}

// Where the vowel (the loudest part) starts, a little before the peak.
export function findVowelOffset(samples, sampleRate) {
  const win = Math.round(0.01 * sampleRate);
  const rms = rmsWindows(samples, win);
  let loudest = 0;
  for (let i = 1; i < rms.length; i++) if (rms[i] > rms[loudest]) loudest = i;
  const offset = Math.max(0, loudest * win - Math.round(0.04 * sampleRate)) / sampleRate;
  const remaining = samples.length / sampleRate - offset;
  return remaining >= 0.15 ? offset : 0;
}

export function reversed(samples) {
  return Float32Array.from(samples).reverse();
}

/**
 * A stand-in voice for people who can't (or don't want to) use the mic:
 * a breathy "h" into a sung "ah" with a little vibrato, padded with room
 * noise so the trimmer has something to cut.
 */
export function synthDemoVoice(sampleRate = 44100, { freq = 233.08, seconds = 0.62, lead = 0.35, tail = 0.4 } = {}) {
  const total = Math.round((lead + seconds + tail) * sampleRate);
  const out = new Float32Array(total);
  const startAt = Math.round(lead * sampleRate);
  const len = Math.round(seconds * sampleRate);
  const formants = [
    { f: 760, bw: 110, g: 1 },
    { f: 1150, bw: 120, g: 0.55 },
    { f: 2500, bw: 180, g: 0.22 },
    { f: 3400, bw: 250, g: 0.08 },
  ];
  const nyquist = sampleRate / 2;
  const harmonics = [];
  for (let n = 1; n * freq < Math.min(5000, nyquist); n++) {
    const hf = n * freq;
    let amp = 0;
    for (const fm of formants) amp += fm.g * Math.exp(-0.5 * ((hf - fm.f) / fm.bw) ** 2);
    harmonics.push({ n, amp: (amp + 0.04) / n ** 0.6 });
  }

  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };

  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const vibrato = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.2);
    const scoop = 1 - 0.02 * Math.exp(-t / 0.05); // slide up into the note
    phase += (2 * Math.PI * freq * vibrato * scoop) / sampleRate;
    let s = 0;
    for (const h of harmonics) s += h.amp * Math.sin(h.n * phase);
    const attack = Math.min(1, t / 0.06);
    const release = Math.min(1, (seconds - t) / 0.12);
    const env = attack * Math.max(0, release) * (1 - 0.15 * (t / seconds));
    const breath = noise() * 0.35 * Math.exp(-t / 0.05); // the "h"
    out[startAt + i] = s * env * 0.32 + breath * 0.25;
  }
  for (let i = 0; i < total; i++) out[i] += noise() * 0.002; // room tone
  return out;
}
