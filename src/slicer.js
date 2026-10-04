// Sample slicer: finds where the syllables and consonants start in a recorded word, so it can be chopped into
// pieces for the jam pads and the melody. Pure functions over Float32Arrays, so Node tests cover them.
//
// Onsets come from three cues measured on short frames 5 ms apart:
// - the rise in loudness, which catches a syllable coming back after a dip ("o-kay", "ba-na-na");
// - the rise in high-frequency loudness, which catches consonants and noises ("t", "k", "ts") even when the
//   overall level doesn't go up;
// - spectral flux over log-spaced bands, which catches a change of sound or a jump in pitch.
// Peaks above a local median plus a margin become onsets. Each one is moved back to the quiet point just before
// its attack, the strongest are kept, and the cuts land on zero crossings.

const FALLBACK_RATE = 44100;
const FLOOR_DB = -60; // this far below the loudest moment counts as silence
const HOP_SEC = 0.005;
const LEVEL_SEC = 0.02; // loudness window for the onset curve: two periods of a low voice, so it doesn't ripple
const FINE_SEC = 0.01; // loudness window for placing a cut
const BANDS_PER_OCTAVE = 6;

const clampIndex = (i, length) => Math.max(0, Math.min(length, Math.round(Number(i) || 0)));
const toDb = (power, ref) => (power > 0 && ref > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(power / ref)) : FLOOR_DB);

/** `count` equal slices covering 0..length. */
export function evenSlices(length, count) {
  const total = Math.max(0, Math.floor(Number(length) || 0));
  const pieces = Math.max(1, Math.min(Math.floor(Number(count) || 1), total || 1));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    out.push({ start: Math.round((i * total) / pieces), end: Math.round(((i + 1) * total) / pieces) });
  }
  return out;
}

/**
 * The nearest boundary to `index` (within `searchSamples`) where the signal crosses zero: sample j is exactly 0, or
 * samples j - 1 and j have opposite signs. Returns `index` itself when there's none within reach.
 */
export function snapToZeroCrossing(samples, index, searchSamples = 0) {
  const length = samples?.length ?? 0;
  const at = clampIndex(index, length);
  if (at <= 0 || at >= length) return at;
  const crosses = (j) => j > 0 && j < length && (samples[j] === 0 || samples[j - 1] * samples[j] < 0);
  const reach = Math.max(0, Math.floor(Number(searchSamples) || 0));
  for (let d = 0; d <= reach; d++) {
    if (crosses(at - d)) return at - d;
    if (d && crosses(at + d)) return at + d;
  }
  return at;
}

/** A copy of one slice with short linear fades, so it starts and ends without a click. */
export function cutSlice(samples, { start = 0, end = samples?.length ?? 0 } = {}, sampleRate = FALLBACK_RATE,
  { fadeIn = 0.003, fadeOut = 0.015 } = {}) {
  const length = samples?.length ?? 0;
  const a = clampIndex(start, length);
  const b = clampIndex(end, length);
  if (b <= a) return new Float32Array(0);
  const out = new Float32Array(b - a);
  for (let i = 0; i < out.length; i++) out[i] = samples[a + i];

  const rate = sampleRate > 0 ? sampleRate : FALLBACK_RATE;
  let fi = Math.max(0, Math.round(fadeIn * rate));
  let fo = Math.max(0, Math.round(fadeOut * rate));
  if (fi + fo > out.length) {
    // a slice shorter than both fades: share it out so they meet in the middle
    const k = out.length / (fi + fo);
    fi = Math.floor(fi * k);
    fo = out.length - fi;
  }
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  return out;
}

// ---------------------------------------------------------------------------
// FFT

const fftTables = new Map();

function tablesFor(size) {
  let t = fftTables.get(size);
  if (t) return t;
  const bits = Math.round(Math.log2(size));
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / size);
  t = { reverse, cos, sin, window };
  fftTables.set(size, t);
  return t;
}

// In-place iterative radix-2 FFT.
function fft(re, im, { reverse, cos, sin }) {
  const size = re.length;
  for (let i = 0; i < size; i++) {
    const j = reverse[i];
    if (j > i) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let a = 0; a < size; a += 2) {
    const tr = re[a + 1];
    const ti = im[a + 1];
    re[a + 1] = re[a] - tr;
    im[a + 1] = im[a] - ti;
    re[a] += tr;
    im[a] += ti;
  }
  for (let span = 4; span <= size; span <<= 1) {
    const half = span >> 1;
    const step = size / span;
    for (let k = 0; k < half; k++) {
      const wr = cos[k * step];
      const wi = sin[k * step];
      for (let a = k; a < size; a += span) {
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Log-spaced bands as [firstBin, endBin) pairs, each at least one bin wide.
function bandLayout(size, rate) {
  const binHz = rate / size;
  const top = Math.min(16000, rate * 0.45);
  const edges = [];
  for (let f = 60; f < top * 2 ** (1 / BANDS_PER_OCTAVE); f *= 2 ** (1 / BANDS_PER_OCTAVE)) {
    const bin = Math.max(1, Math.min(size / 2, Math.round(Math.min(f, top) / binHz)));
    if (!edges.length || bin > edges[edges.length - 1]) edges.push(bin);
  }
  const bands = [];
  for (let i = 0; i + 1 < edges.length; i++) bands.push([edges[i], edges[i + 1]]);
  return bands;
}

// ---------------------------------------------------------------------------
// onset analysis

// Running sums of squares, for the loudness of any window in O(1). `high` uses the first difference of the
// signal, a cheap high-pass that brings out hiss and clicks.
function prefixPowers(samples) {
  const full = new Float64Array(samples.length + 1);
  const high = new Float64Array(samples.length + 1);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const d = v - prev;
    prev = v;
    full[i + 1] = full[i] + v * v;
    high[i + 1] = high[i] + d * d;
  }
  return { full, high };
}

// Mean power of [from, to), with the parts outside the clip counting as silence.
function windowPower(prefix, from, to) {
  const n = prefix.length - 1;
  const a = Math.max(0, Math.min(n, from));
  const b = Math.max(0, Math.min(n, to));
  return b > a ? (prefix[b] - prefix[a]) / (to - from) : 0;
}

// Levels in dB below the loudest frame, one per frame. Frame n hears the audio just before n * hop, so the
// features fire as soon as an onset arrives.
function frameLevels(prefix, frames, hop, win) {
  const out = new Float64Array(frames);
  let top = 0;
  for (let n = 0; n < frames; n++) {
    out[n] = windowPower(prefix, n * hop - win, n * hop);
    if (out[n] > top) top = out[n];
  }
  for (let n = 0; n < frames; n++) out[n] = toDb(out[n], top);
  return top > 0 ? out : null;
}

// How far each frame's level has climbed above the quietest point of the last `span` frames.
function riseFromLow(level, span) {
  const out = new Float64Array(level.length);
  for (let n = 1; n < level.length; n++) {
    let low = level[n - 1];
    for (let k = Math.max(0, n - span); k < n - 1; k++) if (level[k] < low) low = level[k];
    out[n] = Math.max(0, level[n] - low);
  }
  return out;
}

// Band levels (dB below the loudest band anywhere) from a short FFT ending at each frame. Two real frames share
// one complex FFT, one in re and one in im.
function bandLevels(samples, frames, hop, rate) {
  const length = samples.length;
  const size = 2 ** Math.max(6, Math.floor(Math.log2(0.0125 * rate)));
  const tables = tablesFor(size);
  const bands = bandLayout(size, rate);
  const nb = bands.length;
  const out = new Float64Array(frames * nb);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const fill = (buf, end) => {
    const from = end - size;
    for (let i = 0; i < size; i++) {
      const j = from + i;
      buf[i] = j >= 0 && j < length ? samples[j] * tables.window[i] : 0;
    }
  };
  let top = 0;
  for (let n = 0; n < frames; n += 2) {
    const pair = n + 1 < frames;
    fill(re, n * hop);
    if (pair) fill(im, (n + 1) * hop);
    else im.fill(0);
    fft(re, im, tables);
    for (let b = 0; b < nb; b++) {
      let pa = 0;
      let pb = 0;
      for (let k = bands[b][0]; k < bands[b][1]; k++) {
        const zr = re[k];
        const zi = im[k];
        const yr = re[size - k];
        const yi = im[size - k];
        pa += (zr + yr) * (zr + yr) + (zi - yi) * (zi - yi);
        pb += (zi + yi) * (zi + yi) + (zr - yr) * (zr - yr);
      }
      out[n * nb + b] = pa;
      if (pair) out[(n + 1) * nb + b] = pb;
      if (pa > top) top = pa;
      if (pb > top) top = pb;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = toDb(out[i], top);
  return { levels: out, count: nb };
}

// Spectral flux: the mean rise per band (dB) against `lag` frames ago. Each band is compared with the loudest of
// itself and its neighbours back then, so vibrato sliding a harmonic into the next band doesn't count, and the
// first couple of dB are ignored, so a slow swell or a wobbly noise floor doesn't either.
function spectralFlux(bands, frames, lag) {
  const { levels, count } = bands;
  const out = new Float64Array(frames);
  for (let n = lag; n < frames; n++) {
    const cur = n * count;
    const old = (n - lag) * count;
    let sum = 0;
    for (let b = 0; b < count; b++) {
      let before = levels[old + b];
      if (b > 0 && levels[old + b - 1] > before) before = levels[old + b - 1];
      if (b + 1 < count && levels[old + b + 1] > before) before = levels[old + b + 1];
      if (levels[cur + b] > before + 2) sum += levels[cur + b] - before - 2;
    }
    out[n] = sum / count;
  }
  return out;
}

/**
 * Onset candidates in time order: [{ index, strength }], where `index` is the sample to cut at (before the
 * attack, not yet snapped to a zero crossing). Higher `sensitivity` (0..1) lets weaker onsets through.
 */
export function findOnsets(samples, sampleRate, { sensitivity = 0.5, trace } = {}) {
  const length = samples?.length ?? 0;
  const rate = sampleRate > 0 ? sampleRate : FALLBACK_RATE;
  const hop = Math.max(1, Math.round(HOP_SEC * rate));
  const levelWin = Math.max(2, Math.round(LEVEL_SEC * rate));
  const fineWin = Math.max(2, Math.round(FINE_SEC * rate));
  const frameOf = (sec) => Math.max(1, Math.round((sec * rate) / hop));
  if (length < levelWin) return [];

  const power = prefixPowers(samples);
  const frames = Math.ceil(length / hop) + 1;
  const level = frameLevels(power.full, frames, hop, levelWin);
  const hiLevel = frameLevels(power.high, frames, hop, levelWin);
  if (!level || !hiLevel) return [];

  // The onset curve, in dB: how far the level (or the high end) has come up from a recent dip, plus flux.
  const rise = riseFromLow(level, frameOf(0.06));
  const hiRise = riseFromLow(hiLevel, frameOf(0.06));
  const flux = spectralFlux(bandLevels(samples, frames, hop, rate), frames, 2);
  const next = Math.round(levelWin / hop);
  const odf = new Float64Array(frames);
  for (let n = 0; n < frames; n++) {
    // An onset is the start of something, so weigh it by how loud the next 20 ms are: quiet stuff (breaths, room
    // noise) counts for less, and the splash at the end of a sound that stops dead doesn't count at all.
    const after = Math.min(frames - 1, n + next);
    const loud = Math.max(level[after], hiLevel[after]);
    const weight = Math.min(1, Math.max(0, (loud + 45) / 30));
    odf[n] = weight * (Math.max(rise[n], hiRise[n]) + flux[n]);
  }

  // Peaks that stand out from the dip before them (since the previous peak, at most 100 ms back) by a margin
  // that shrinks as the sensitivity goes up. Wobbles on top of one long hump don't count again.
  const s = Math.min(1, Math.max(0, Number(sensitivity) || 0));
  const margin = 24 * (3 / 24) ** s;
  const history = frameOf(0.1);
  const near = frameOf(0.02);
  const peaks = [];
  let prevPeak = 0;
  for (let n = 1; n < frames - 1; n++) {
    const v = odf[n];
    if (!(v > 0)) continue;
    let isPeak = true;
    for (let k = 1; k <= near && isPeak; k++) {
      if (n - k >= 0 && odf[n - k] >= v) isPeak = false;
      if (n + k < frames && odf[n + k] > v) isPeak = false;
    }
    if (!isPeak) continue;
    let base = v;
    for (let k = Math.max(prevPeak, n - history); k < n; k++) if (odf[k] < base) base = odf[k];
    prevPeak = n;
    if (v - base > margin) peaks.push({ frame: n, strength: v - base });
  }
  if (trace) Object.assign(trace, { odf, level, hiLevel, hop, peaks, margin, rise, hiRise, flux });

  // Peaks close together are one event (a "t" then its vowel): keep the earlier unless the later is much stronger.
  const group = frameOf(0.04);
  const out = [];
  let lastFrame = -Infinity;
  let prevEvent = 0;
  for (const p of peaks) {
    const last = out[out.length - 1];
    if (last && p.frame - lastFrame <= group) {
      if (p.strength <= last.strength * 2.5) {
        last.strength = Math.max(last.strength, p.strength);
        continue;
      }
      out.pop();
    } else if (last) prevEvent = lastFrame * hop;
    lastFrame = p.frame;
    out.push({ index: refine(p.frame * hop, prevEvent, power, fineWin, rate), strength: p.strength });
  }
  return out;
}

// Move an onset back to just before its attack: find where the level starts climbing towards the peak it reaches
// around `t`. Uses whichever of the full or high-passed level rises more, so it works for vowels and for hiss.
function refine(t, notBefore, power, levelWin, rate) {
  const length = power.full.length - 1;
  const step = Math.max(1, Math.round(rate / 2000));
  const from = Math.max(notBefore, t - Math.round(0.08 * rate), 0);
  const to = Math.min(length, t + Math.round(0.01 * rate));
  let best = null;
  for (const prefix of [power.full, power.high]) {
    const at = [];
    const db = [];
    for (let p = from; p <= to; p += step) {
      at.push(p);
      db.push(10 * Math.log10(windowPower(prefix, p - levelWin, p) + 1e-12));
    }
    if (at.length < 2) continue;
    // the top of this rise: the loudest point from a little before t to the end of the search
    let top = 0;
    while (top + 1 < at.length && at[top] < t - levelWin / 2) top++;
    for (let i = top + 1; i < at.length; i++) if (db[i] > db[top]) top = i;
    let low = 0;
    for (let i = 1; i <= top; i++) if (db[i] < db[low]) low = i;
    const rise = db[top] - db[low];
    // the last point still near the bottom; the window ending there hasn't heard the attack yet
    let quiet = low;
    for (let i = low; i <= top; i++) if (db[i] <= db[low] + 2) quiet = i;
    if (!best || rise > best.rise) best = { rise, index: at[quiet] };
  }
  return best && best.rise >= 3 ? best.index : Math.max(0, t - Math.round(levelWin / 2));
}

/**
 * Chop a word into slices at its syllables and consonants: [{ start, end }] sample ranges that are sorted,
 * contiguous and cover 0..samples.length. Always at least one slice; at most `maxSlices`, the strongest onsets
 * first, none shorter than `minSliceSec`. Higher `sensitivity` (0..1) gives more slices.
 */
export function detectSlices(samples, sampleRate, { maxSlices = 8, minSliceSec = 0.06, sensitivity = 0.5 } = {}) {
  const length = samples?.length ?? 0;
  const rate = sampleRate > 0 ? sampleRate : FALLBACK_RATE;
  const wanted = Math.max(1, Math.floor(Number(maxSlices) || 1));
  const minLength = Math.max(1, Math.round(Math.max(0, Number(minSliceSec) || 0) * rate));
  const reach = Math.round(0.002 * rate);
  if (wanted < 2 || length < 2 * (minLength + reach)) return [{ start: 0, end: length }];

  // Onsets closer than a slice are merged. The earlier one wins unless the later is much stronger, so a "t" stays
  // stuck to the front of its vowel. The room left for snapping keeps every slice at least minLength.
  const gap = minLength + 2 * reach;
  const merged = [];
  for (const onset of findOnsets(samples, rate, { sensitivity })) {
    if (onset.index < minLength + reach || length - onset.index < minLength + reach) continue;
    const last = merged[merged.length - 1];
    if (last && onset.index - last.index < gap) {
      if (onset.strength > last.strength * 2.5) Object.assign(last, onset);
      else last.strength = Math.max(last.strength, onset.strength);
    } else merged.push({ ...onset });
  }
  const cuts = merged
    .sort((a, b) => b.strength - a.strength)
    .slice(0, wanted - 1)
    .map((o) => o.index)
    .sort((a, b) => a - b);

  const slices = [];
  let start = 0;
  for (const cut of cuts) {
    const end = snapToZeroCrossing(samples, cut, reach);
    slices.push({ start, end });
    start = end;
  }
  slices.push({ start, end: length });
  return slices;
}
