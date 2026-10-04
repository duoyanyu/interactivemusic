import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALES,
  chordPcs,
  chordSymbol,
  degreeToMidi,
  freqToMidi,
  keyName,
  midiToFreq,
  midiToName,
  mod,
  romanNumeral,
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
