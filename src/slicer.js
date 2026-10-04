// Sample slicer: finds where the syllables and consonants start in a recorded word, so it can be chopped into
// pieces for the jam pads and the melody. Pure functions over Float32Arrays, so Node tests cover them.
//
// The onset curve is measured every 5 ms and adds up, in dB:
// - how far the loudness has climbed out of a dip in the last 60 ms, which catches a syllable coming back
//   ("o-kay", "ba-na-na");
// - the same for a high-passed copy, which catches consonants and noises ("t", "k", "ts") even when the overall
//   level doesn't go up (the larger of the two counts);
// - spectral flux over log-spaced bands of a ~12 ms FFT, for sharp changes in the sound.
// Peaks that stand out from the dip before them by a margin (set by the sensitivity) are onsets, and so are clear
// jumps between two held pitches. Each onset moves back to the quiet point just before its attack. Then onsets
// closer than a slice merge, the strongest are kept, and the cuts land on zero crossings.

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
    const xr = re[a];
    const xi = im[a];
    const yr = re[a + 1];
    const yi = im[a + 1];
    re[a] = xr + yr;
    im[a] = xi + yi;
    re[a + 1] = xr - yr;
    im[a + 1] = xi - yi;
  }
  for (let span = 4; span <= size; span <<= 1) {
    const half = span >> 1;
    const step = size / span;
    for (let k = 0, w = 0; k < half; k++, w += step) {
      const wr = cos[w];
      const wi = sin[w];
      for (let a = k, b = k + half; a < size; a += span, b += span) {
        const xr = re[b];
        const xi = im[b];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        const ar = re[a];
        const ai = im[a];
        re[a] = ar + tr;
        im[a] = ai + ti;
        re[b] = ar - tr;
        im[b] = ai - ti;
      }
    }
  }
}

// Edges (in FFT bins) of log-spaced bands, each at least one bin wide.
function bandEdges(size, rate) {
  const binHz = rate / size;
  const top = Math.min(16000, rate * 0.45);
  const edges = [];
  for (let f = 60; f < top * 2 ** (1 / BANDS_PER_OCTAVE); f *= 2 ** (1 / BANDS_PER_OCTAVE)) {
    const bin = Math.max(1, Math.min(size / 2, Math.round(Math.min(f, top) / binHz)));
    if (!edges.length || bin > edges[edges.length - 1]) edges.push(bin);
  }
  return Int32Array.from(edges);
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

// The `window.length` samples ending at `end`, windowed, into `buf`; outside the clip counts as silence.
function windowed(buf, samples, end, window) {
  const size = window.length;
  const from = end - size;
  if (from >= 0 && end <= samples.length) {
    for (let i = 0; i < size; i++) buf[i] = samples[from + i] * window[i];
  } else {
    for (let i = 0, j = from; i < size; i++, j++) buf[i] = j >= 0 && j < samples.length ? samples[j] * window[i] : 0;
  }
}

// Band levels (dB below the loudest band anywhere) from a short FFT ending at every other frame; the frame in
// between repeats it. Two real frames share one complex FFT, one in re and one in im.
function bandLevels(samples, frames, hop, rate) {
  // about 12 ms: long enough to span a low voice's pitch period, short enough to keep consonants sharp
  const size = 2 ** Math.max(6, Math.ceil(Math.log2(0.0105 * rate)));
  const tables = tablesFor(size);
  const { window } = tables;
  const edges = bandEdges(size, rate);
  const nb = edges.length - 1;
  const out = new Float64Array(frames * nb);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let top = 0;
  for (let n = 0; n < frames; n += 4) {
    windowed(re, samples, n * hop, window);
    windowed(im, samples, (n + 2) * hop, window);
    fft(re, im, tables);
    for (let b = 0; b < nb; b++) {
      let pa = 0;
      let pb = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) {
        const zr = re[k];
        const zi = im[k];
        const yr = re[size - k];
        const yi = im[size - k];
        pa += (zr + yr) * (zr + yr) + (zi - yi) * (zi - yi);
        pb += (zi + yi) * (zi + yi) + (zr - yr) * (zr - yr);
      }
      for (let m = n; m < n + 4 && m < frames; m++) out[m * nb + b] = m < n + 2 ? pa : pb;
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

// ---------------------------------------------------------------------------
// pitch jumps

// Pitch of one frame by McLeod's normalised square difference (NSDF): the first autocorrelation peak that comes
// close to the best one, which dodges most octave errors. `acf` is the frame's autocorrelation times `scale`,
// `energy` the running sum of its squares. Returns { lag, clarity } or null.
function nsdfPeak(acf, scale, energy, win, minLag, maxLag) {
  const peaks = [];
  let top = null;
  let crossed = false;
  for (let lag = 1; lag <= maxLag; lag++) {
    const m = energy[win - lag] + energy[win] - energy[lag];
    const v = m > 0 ? (2 * acf[lag]) / (scale * m) : 0;
    if (v < 0) {
      if (top) peaks.push(top);
      crossed = true;
      top = null;
    } else if (crossed && lag >= minLag && (!top || v > top.v)) {
      top = { lag, v };
    }
  }
  if (top && top.lag < maxLag) peaks.push(top);
  let best = 0;
  for (const p of peaks) best = Math.max(best, p.v);
  const pick = peaks.find((p) => p.v >= 0.9 * best);
  return pick ? { lag: pick.lag, clarity: pick.v } : null;
}

// Downsample by `factor`: block averages, then a [1 2 1] smoothing, which is plenty of low-pass for a pitch tracker.
function decimate(samples, factor) {
  const length = Math.floor(samples.length / factor);
  const blocks = new Float64Array(length);
  for (let j = 0, i = 0; j < length; j++) {
    let sum = 0;
    for (const end = i + factor; i < end; i++) sum += samples[i];
    blocks[j] = sum / factor;
  }
  const out = new Float64Array(length);
  for (let j = 0; j < length; j++) {
    out[j] = 0.5 * blocks[j] + 0.25 * (blocks[j > 0 ? j - 1 : j] + blocks[j + 1 < length ? j + 1 : j]);
  }
  return out;
}

// Copy a frame into the first `win` slots of `buf`, zero the rest, and keep a running sum of squares in `energy`.
function loadFrame(buf, energy, x, from, win) {
  for (let i = 0; i < win; i++) {
    const v = x[from + i];
    buf[i] = v;
    energy[i + 1] = energy[i] + v * v;
  }
  buf.fill(0, win);
}

// Pitch (MIDI, fractional) and clarity every `hop` samples of `x`, 256-sample windows.
function trackPitch(x, rate, hop) {
  const win = 256;
  const size = 512;
  const frames = x.length >= win ? Math.floor((x.length - win) / hop) + 1 : 0;
  const midi = new Float64Array(frames).fill(NaN);
  const clarity = new Float64Array(frames);
  const loud = new Float64Array(frames);
  const tables = tablesFor(size);
  const minLag = Math.max(2, Math.floor(rate / 1000));
  const maxLag = Math.min(win - 2, Math.ceil(rate / 65));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const energy = [new Float64Array(win + 1), new Float64Array(win + 1)];
  for (let f = 0; f < frames; f += 2) {
    const pair = f + 1 < frames;
    loadFrame(re, energy[0], x, f * hop, win);
    if (pair) loadFrame(im, energy[1], x, (f + 1) * hop, win);
    else im.fill(0);
    // Power spectra of both frames, then one more FFT of them (both real and even) gives both autocorrelations.
    fft(re, im, tables);
    for (let k = 0; k <= size / 2; k++) {
      const j = (size - k) % size;
      const zr = re[k];
      const zi = im[k];
      const yr = re[j];
      const yi = im[j];
      const pa = ((zr + yr) * (zr + yr) + (zi - yi) * (zi - yi)) / 4;
      const pb = ((zi + yi) * (zi + yi) + (zr - yr) * (zr - yr)) / 4;
      re[k] = pa;
      re[j] = pa;
      im[k] = pb;
      im[j] = pb;
    }
    fft(re, im, tables);
    for (let which = 0; which < (pair ? 2 : 1); which++) {
      const acf = which ? im : re;
      const frame = f + which;
      loud[frame] = energy[which][win];
      const peak = nsdfPeak(acf, size, energy[which], win, minLag, maxLag);
      if (!peak) continue;
      let lag = peak.lag;
      const a = acf[lag - 1];
      const b = acf[lag];
      const c = acf[lag + 1];
      if (a + c - 2 * b !== 0) lag += (a - c) / (2 * (a + c - 2 * b));
      midi[frame] = 69 + 12 * Math.log2(rate / lag / 440);
      clarity[frame] = peak.clarity;
    }
  }
  return { midi, clarity, loud, win };
}

/**
 * Places where a held pitch jumps to another one (a sung "la-la" with no gap). Pitch is tracked every 20 ms on a
 * copy downsampled to about 11 kHz. A jump counts when both sides are clearly voiced and steady for 60 ms, it's
 * at least 3 semitones, and it isn't an octave (the classic pitch tracker mistake). Glides and vibrato don't count.
 */
function pitchJumps(samples, rate) {
  const factor = Math.max(1, Math.round(rate / 11025));
  const low = rate / factor;
  const hop = Math.round(0.02 * low);
  const { midi, clarity, loud, win } = trackPitch(decimate(samples, factor), low, hop);
  const frames = midi.length;
  if (frames < 6) return [];

  let loudest = 0;
  for (const v of loud) loudest = Math.max(loudest, v);
  // the middle note of three voiced, steady frames, or null
  const side = (from) => {
    const notes = [];
    for (let f = from; f < from + 3; f++) {
      if (!(clarity[f] >= 0.8 && loud[f] >= loudest * 0.03)) return null;
      notes.push(midi[f]);
    }
    notes.sort((a, b) => a - b);
    return notes[2] - notes[0] <= 0.6 ? notes[1] : null;
  };
  const jumps = [];
  for (let f = 3; f + 3 <= frames; f++) {
    const before = side(f - 3);
    if (before === null) continue;
    // the frame right at the change hears both notes, so the new note may only settle a frame later
    let start = f;
    let after = side(f);
    if (after === null && f + 4 <= frames) after = side(++start);
    if (after === null) continue;
    const interval = Math.abs(after - before);
    if (interval < 3 || Math.abs(interval - 12) < 1 || interval > 18) continue;
    const index = Math.round((((f - 1 + start) / 2) * hop + win / 2) * factor);
    // one jump shows up on a few frames in a row: keep the biggest
    const last = jumps[jumps.length - 1];
    if (last && f - last.frame <= 3) {
      if (interval > last.interval) Object.assign(last, { frame: f, interval, index });
    } else jumps.push({ frame: f, interval, index });
  }
  return jumps.map(({ interval, index }) => ({ index, strength: 3 * Math.min(interval, 10) }));
}

/**
 * Onset candidates in time order: [{ index, strength }], where `index` is the sample to cut at (before the
 * attack, not yet snapped to a zero crossing). Higher `sensitivity` (0..1) lets weaker onsets through.
 */
export function findOnsets(samples, sampleRate, { sensitivity = 0.5 } = {}) {
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

  // Clear pitch jumps count too. Their place is already exact, so they only look for a dip just before.
  for (const { index, strength } of pitchJumps(samples, rate)) {
    if (strength > margin) peaks.push({ frame: Math.round(index / hop), strength, at: index });
  }
  peaks.sort((a, b) => a.frame - b.frame);

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
    const index = p.at === undefined
      ? refine(p.frame * hop, prevEvent, power, fineWin, rate, 0.08, p.frame * hop - fineWin / 2)
      : refine(p.at, prevEvent, power, fineWin, rate, 0.03, p.at);
    out.push({ index, strength: p.strength });
  }
  return out;
}

// Move an onset back to just before its attack: find where the level starts climbing towards the peak it reaches
// around `t`. Uses whichever of the full or high-passed level rises more, so it works for vowels and for hiss.
function refine(t, notBefore, power, levelWin, rate, backSec, fallback) {
  const length = power.full.length - 1;
  const step = Math.max(1, Math.round(rate / 2000));
  const from = Math.max(notBefore, t - Math.round(backSec * rate), 0);
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
  return best && best.rise >= 3 ? best.index : Math.max(0, Math.round(fallback));
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
  const onsets = findOnsets(samples, rate, { sensitivity }).sort((a, b) => a.index - b.index);
  const merged = [];
  for (const onset of onsets) {
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
