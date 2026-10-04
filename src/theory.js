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

export function usesFlats(tonicPc, mode) {
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
