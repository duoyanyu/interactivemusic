import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALES,
  chordForRoot,
  chordPcs,
  chordSymbol,
  degreeToMidi,
  freqToMidi,
  keyName,
  midiToFreq,
  midiToName,
  mod,
  nearestInSet,
  recognizeChord,
  romanNumeral,
  usesFlats,
  voiceChord,
} from '../src/theory.js';

test('midi <-> frequency', () => {
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(freqToMidi(261.6256) - 60) < 0.001);
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(70), 'A#4');
  assert.equal(midiToName(70, true), 'Bb4');
});

test('scale degrees wrap across octaves', () => {
  const major = SCALES.major;
  assert.equal(degreeToMidi(60, major, 0), 60);
  assert.equal(degreeToMidi(60, major, 4), 67);
  assert.equal(degreeToMidi(60, major, 7), 72);
  assert.equal(degreeToMidi(60, major, -1), 59);
  assert.equal(degreeToMidi(60, major, -3), 55);
});

test('diatonic chord names', () => {
  assert.equal(chordSymbol(0, SCALES.major, 0, 3), 'C');
  assert.equal(chordSymbol(0, SCALES.major, 1, 3), 'Dm');
  assert.equal(chordSymbol(0, SCALES.major, 4, 4), 'G7');
  assert.equal(chordSymbol(0, SCALES.major, 3, 4), 'Fmaj7');
  assert.equal(chordSymbol(0, SCALES.major, 0, 5), 'Cmaj9');
  assert.equal(chordSymbol(9, SCALES.minor, 0, 4), 'Am7');
  assert.equal(chordSymbol(9, SCALES.minor, 5, 3), 'F');
  assert.equal(chordSymbol(9, SCALES.minor, 1, 3), 'Bdim');
  assert.equal(chordSymbol(3, SCALES.minor, 0, 3, true), 'Ebm');
  assert.equal(chordSymbol(0, SCALES.lydian, 1, 3), 'D');
});

test('roman numerals follow chord quality', () => {
  assert.equal(romanNumeral(SCALES.minor, 0), 'i');
  assert.equal(romanNumeral(SCALES.minor, 5), 'VI');
  assert.equal(romanNumeral(SCALES.minor, 1), 'ii°');
  assert.equal(romanNumeral(SCALES.major, 4), 'V');
});

test('key names pick sharps or flats', () => {
  assert.equal(keyName(3, 'minor'), 'Eb minor');
  assert.equal(keyName(1, 'minor'), 'C# minor');
  assert.equal(keyName(10, 'major'), 'Bb major');
  assert.equal(keyName(6, 'lydian'), 'F# lydian');
  assert.equal(chordSymbol(9, SCALES.phrygian, 1, 3, usesFlats(9, 'phrygian')), 'Bb');
  assert.equal(chordSymbol(0, SCALES.mixolydian, 6, 3, usesFlats(0, 'mixolydian')), 'Bb');
  assert.equal(chordSymbol(4, SCALES.phrygian, 1, 3, usesFlats(4, 'phrygian')), 'F');
});

test('voicings stay in range and keep every chord tone', () => {
  let prev = null;
  for (const root of [0, 5, 3, 4, 0]) {
    const pcs = chordPcs(9, SCALES.minor, root, 4);
    const v = voiceChord(pcs, prev, { low: 50, high: 74 });
    assert.equal(v.length, pcs.length);
    assert.ok(v.every((n) => n >= 50 && n <= 74), `out of range: ${v}`);
    assert.deepEqual([...new Set(v.map((n) => mod(n, 12)))].sort(), [...pcs].sort());
    if (prev) {
      const moved = v.reduce((sum, n) => sum + Math.min(...prev.map((p) => Math.abs(p - n))), 0);
      assert.ok(moved <= 12, `voice leading jumped too far: ${prev} -> ${v}`);
    }
    prev = v;
  }
});


test('live chords fit the key', () => {
  // C major: D -> Dm, G -> G, B -> Bdim, F# (outside) -> F# major
  assert.equal(chordForRoot(62, 0, 'major').symbol, 'Dm');
  assert.equal(chordForRoot(67, 0, 'major').symbol, 'G');
  assert.equal(chordForRoot(55, 0, 'major', { size: 4 }).symbol, 'G7');
  assert.equal(chordForRoot(71, 0, 'major').symbol, 'Bdim');
  assert.equal(chordForRoot(66, 0, 'major').symbol, 'F#');
  assert.equal(chordForRoot(66, 0, 'major').degree, -1);
  // A minor: C -> C major, E -> Em
  assert.deepEqual(chordForRoot(60, 9, 'minor').pcs, [0, 4, 7]);
  assert.equal(chordForRoot(64, 9, 'minor').symbol, 'Em');
  assert.equal(chordForRoot(64, 9, 'minor', { type: 'major' }).symbol, 'E');
  assert.equal(chordForRoot(64, 9, 'minor', { type: 'power' }).symbol, 'E5');
  assert.equal(chordForRoot(65, 9, 'minor', { type: 'seventh' }).symbol, 'Fmaj7');
});

test('recognizeChord names held notes', () => {
  assert.equal(recognizeChord([60, 64, 67]).symbol, 'C');
  assert.equal(recognizeChord([57, 60, 64]).symbol, 'Am');
  assert.equal(recognizeChord([64, 67, 72]).symbol, 'C'); // first inversion
  assert.equal(recognizeChord([55, 59, 62, 65]).symbol, 'G7');
  assert.equal(recognizeChord([62, 65, 69, 72]).symbol, 'Dm7');
  assert.equal(recognizeChord([60, 67]).symbol, 'C5');
  assert.equal(recognizeChord([60]), null);
});

test('nearestInSet snaps to chord tones', () => {
  assert.equal(nearestInSet(61, [0, 4, 7]), 60);
  assert.equal(nearestInSet(66, [0, 4, 7]), 67);
  assert.equal(nearestInSet(64, [0, 4, 7]), 64);
});
