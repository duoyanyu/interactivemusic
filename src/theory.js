// Music theory helpers: notes, scales, diatonic chords, voicings.
// Melodies and chords are written as scale degrees (0 = tonic, 7 = tonic an
// octave up, -1 = leading tone below) and only turned into MIDI at the end.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export const SCALE_LABELS = {
  major: 'Major',
  minor: 'Minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Tonics that read better with flats, per mode family.
const FLAT_TONICS = {
  major: [1, 3, 5, 8, 10],
  minor: [0, 2, 3, 5, 7, 10],
};

export const mod = (n, m) => ((n % m) + m) % m;

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

// Phrygian and mixolydian borrow the spelling of their relative major
// (A phrygian is spelled like F major, so its second chord is Bb, not A#).
const RELATIVE_MAJOR = { phrygian: 8, mixolydian: 5 };

export function usesFlats(tonicPc, mode) {
  if (RELATIVE_MAJOR[mode] !== undefined) return FLAT_TONICS.major.includes(mod(tonicPc + RELATIVE_MAJOR[mode], 12));
  const family = mode === 'minor' || mode === 'dorian' ? 'minor' : 'major';
  return FLAT_TONICS[family].includes(mod(tonicPc, 12));
}

export function pcName(pc, flats = false) {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod(Math.round(pc), 12)];
}

export function midiToName(midi, flats = false) {
  const m = Math.round(midi);
  return pcName(m, flats) + (Math.floor(m / 12) - 1);
}

export function keyName(tonicPc, mode) {
  return `${pcName(tonicPc, usesFlats(tonicPc, mode))} ${mode}`;
}

export function degreeToMidi(tonicMidi, scale, degree) {
  const n = scale.length;
  return tonicMidi + scale[mod(degree, n)] + 12 * Math.floor(degree / n);
}

// Scale degrees of a chord built by stacking diatonic thirds on `root`.
export function chordDegrees(root, size = 3) {
  return Array.from({ length: size }, (_, i) => root + 2 * i);
}

// Pitch classes (0-11) of a diatonic chord.
export function chordPcs(tonicPc, scale, root, size = 3) {
  return chordDegrees(root, size).map((d) => mod(tonicPc + degreeToMidi(0, scale, d), 12));
}

// Semitone intervals above the chord root.
function chordIntervals(scale, root, size) {
  const base = degreeToMidi(0, scale, root);
  return chordDegrees(root, size).map((d) => degreeToMidi(0, scale, d) - base);
}

export function chordQuality(scale, root) {
  const [, third, fifth] = chordIntervals(scale, root, 3);
  if (third === 4 && fifth === 7) return 'major';
  if (third === 3 && fifth === 7) return 'minor';
  if (third === 3 && fifth === 6) return 'dim';
  if (third === 4 && fifth === 8) return 'aug';
  return 'other';
}

export function chordSymbol(tonicPc, scale, root, size, flats = false) {
  const iv = chordIntervals(scale, root, size);
  const rootName = pcName(tonicPc + degreeToMidi(0, scale, root), flats);
  const quality = chordQuality(scale, root);
  const seventh = iv[3];
  const hasNinth = size >= 5;
  let suffix;
  if (quality === 'major') {
    if (seventh === undefined) suffix = '';
    else if (seventh === 11) suffix = hasNinth ? 'maj9' : 'maj7';
    else suffix = hasNinth ? '9' : '7';
  } else if (quality === 'minor') {
    if (seventh === undefined) suffix = 'm';
    else if (seventh === 10) suffix = hasNinth ? 'm9' : 'm7';
    else suffix = 'm(maj7)';
  } else if (quality === 'dim') {
    suffix = seventh === undefined ? 'dim' : 'm7b5';
  } else {
    suffix = 'aug';
  }
  return rootName + suffix;
}

export function romanNumeral(scale, root) {
  const quality = chordQuality(scale, root);
  const numeral = ROMAN[mod(root, 7)];
  if (quality === 'minor') return numeral.toLowerCase();
  if (quality === 'dim') return numeral.toLowerCase() + '°';
  return numeral;
}

// Pick a close-position voicing for `pcs` inside [low, high] that moves as
// little as possible from the previous voicing.
export function voiceChord(pcs, prev = null, { low = 52, high = 76, center = 62 } = {}) {
  const candidates = [];
  for (let rot = 0; rot < pcs.length; rot++) {
    const order = pcs.slice(rot).concat(pcs.slice(0, rot));
    for (let base = low; base < low + 12; base++) {
      if (mod(base, 12) !== order[0]) continue;
      const notes = [base];
      for (let i = 1; i < order.length; i++) {
        let n = notes[i - 1] + 1;
        while (mod(n, 12) !== order[i]) n++;
        notes.push(n);
      }
      // allow the same shape an octave up if it still fits
      for (let shift = 0; notes[notes.length - 1] + shift <= high; shift += 12) {
        candidates.push(notes.map((n) => n + shift));
      }
    }
  }
  if (!candidates.length) return pcs.map((pc) => low + mod(pc - low, 12));

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  let best = candidates[0];
  let bestScore = Infinity;
  for (const cand of candidates) {
    let score = Math.abs(mean(cand) - center) * 0.35;
    if (prev && prev.length) {
      for (const n of cand) score += Math.min(...prev.map((p) => Math.abs(p - n)));
    }
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

// --- live chords -------------------------------------------------------------

export const CHORD_TYPES = {
  diatonic: 'Fit the key',
  major: 'Major',
  minor: 'Minor',
  power: 'Power (root + 5th)',
  sus2: 'Sus2',
  seventh: '7th that fits the key',
};

const SHAPES = {
  major: { iv: [0, 4, 7], suffix: '' },
  minor: { iv: [0, 3, 7], suffix: 'm' },
  dim: { iv: [0, 3, 6], suffix: 'dim' },
  aug: { iv: [0, 4, 8], suffix: 'aug' },
  sus2: { iv: [0, 2, 7], suffix: 'sus2' },
  sus4: { iv: [0, 5, 7], suffix: 'sus4' },
  power: { iv: [0, 7], suffix: '5' },
  dom7: { iv: [0, 4, 7, 10], suffix: '7' },
  maj7: { iv: [0, 4, 7, 11], suffix: 'maj7' },
  min7: { iv: [0, 3, 7, 10], suffix: 'm7' },
  m7b5: { iv: [0, 3, 6, 10], suffix: 'm7b5' },
};

// Scale degree of a pitch class in a key, or -1 if it's outside the scale.
export function degreeOf(pc, tonicPc, scale) {
  return scale.indexOf(mod(pc - tonicPc, 12));
}

/**
 * The chord to play when someone presses `rootMidi` in a key. "diatonic"
 * builds the chord the scale gives that note (D in C major is Dm); a note
 * outside the scale gets a major chord, the usual borrowed-chord sound.
 * Returns { rootPc, pcs, symbol, degree } (degree is -1 outside the scale).
 */
export function chordForRoot(rootMidi, tonicPc, mode, { type = 'diatonic', size = 3 } = {}) {
  const scale = SCALES[mode] ?? SCALES.minor;
  const rootPc = mod(Math.round(rootMidi), 12);
  const degree = degreeOf(rootPc, tonicPc, scale);
  const flats = usesFlats(tonicPc, mode);
  const fromShape = (shape) => ({
    rootPc,
    pcs: SHAPES[shape].iv.map((i) => mod(rootPc + i, 12)),
    symbol: pcName(rootPc, flats) + SHAPES[shape].suffix,
    degree,
  });
  if (type === 'major' || type === 'minor' || type === 'power' || type === 'sus2') return fromShape(type);
  if (degree < 0) return fromShape(type === 'seventh' ? 'dom7' : 'major');
  const s = type === 'seventh' ? Math.max(4, size) : size;
  const quality = chordQuality(scale, degree);
  const n = quality === 'dim' && s > 4 ? 4 : s;
  return {
    rootPc,
    pcs: chordPcs(tonicPc, scale, degree, n),
    symbol: chordSymbol(tonicPc, scale, degree, n, flats),
    degree,
  };
}

/**
 * Name the chord in a handful of held notes (from a MIDI keyboard). Tries
 * every held note as the root against common shapes; the lowest note wins
 * ties. Returns { rootPc, shape, symbol } or null for fewer than 2 notes.
 */
export function recognizeChord(midiNotes, flats = false) {
  const notes = [...new Set(midiNotes.map((n) => Math.round(n)))].sort((a, b) => a - b);
  if (notes.length < 2) return null;
  const pcs = [...new Set(notes.map((n) => mod(n, 12)))];
  const bassPc = mod(notes[0], 12);
  let best = null;
  for (const root of pcs) {
    const rel = new Set(pcs.map((pc) => mod(pc - root, 12)));
    for (const [shape, { iv, suffix }] of Object.entries(SHAPES)) {
      const hit = iv.filter((i) => rel.has(i)).length;
      if (!rel.has(0) || hit < Math.min(2, iv.length)) continue;
      const missing = iv.length - hit;
      const extra = rel.size - hit;
      const score = hit * 2 - missing * 1.5 - extra * 1.2 + (root === bassPc ? 0.6 : 0) - (shape === 'power' ? 0.3 : 0);
      if (!best || score > best.score) best = { rootPc: root, shape, symbol: pcName(root, flats) + suffix, score };
    }
  }
  return best && { rootPc: best.rootPc, shape: best.shape, symbol: best.symbol, pcs: SHAPES[best.shape].iv.map((i) => mod(best.rootPc + i, 12)) };
}

// Pitch class set -> nearest MIDI note to `midi` whose pitch class is in it.
export function nearestInSet(midi, pcs) {
  for (let d = 0; d < 12; d++) {
    if (pcs.includes(mod(midi - d, 12))) return midi - d;
    if (pcs.includes(mod(midi + d, 12))) return midi + d;
  }
  return midi;
}
