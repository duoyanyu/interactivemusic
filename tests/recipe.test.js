import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOOD_IDS,
  RECIPE_GROUPS,
  buildSong,
  decodeRecipe,
  encodeRecipe,
  progressionsFor,
  rollRecipe,
  subSeed,
  validRecipe,
} from '../src/composer.js';
import { SCALES } from '../src/theory.js';

test('rolled recipes are valid for every mood', () => {
  for (const mood of MOOD_IDS) {
    for (const seed of [1, 99, 123456]) {
      const r = rollRecipe(mood, seed);
      assert.ok(validRecipe(r), `${mood} ${seed}`);
      assert.equal(r.mood, mood);
    }
  }
});

test('locked groups survive a re-roll, unlocked ones change', () => {
  const a = rollRecipe('hype', 1);
  const b = rollRecipe('dreamy', 2, { keep: a, locks: ['harmony', 'structure'] });
  for (const f of RECIPE_GROUPS.harmony) assert.deepEqual(b[f], a[f], f);
  assert.deepEqual(b.bars, a.bars);
  assert.equal(b.mood, 'dreamy');
  assert.notEqual(b.melodySeed, a.melodySeed);
  // locked values are copies, not shared references
  const before = a.progression[0];
  b.progression[0] = before === 6 ? 5 : 6;
  assert.equal(a.progression[0], before);
});

test('the same recipe always builds the same song', () => {
  const r = rollRecipe('chill', 5);
  assert.deepEqual(buildSong(r, 57), buildSong(structuredClone(r), 57));
});

test('a new melody seed only changes the chops', () => {
  const r = rollRecipe('retro', 8);
  const a = buildSong(r, 57);
  const b = buildSong({ ...r, melodySeed: subSeed(1, 'other') }, 57);
  assert.deepEqual(a.tracks.pad.map((e) => e.notes), b.tracks.pad.map((e) => e.notes));
  assert.deepEqual(a.tracks.kick.map((e) => e.step), b.tracks.kick.map((e) => e.step));
  assert.notDeepEqual(a.hook, b.hook);
});

test('studio edits show up in the song', () => {
  const r = rollRecipe('hype', 3);
  const song = buildSong({ ...r, tonic: 2, mode: 'dorian', progression: [...progressionsFor('hype', 'dorian')[0]], bpm: 101 }, 60);
  assert.equal(song.key, 'D dorian');
  assert.equal(song.bpm, 101);
  const dorian = SCALES.dorian.map((i) => (i + 2) % 12);
  for (const e of song.tracks.pad) for (const n of e.notes) assert.ok(dorian.includes(n % 12));

  const longer = buildSong({ ...r, bars: { intro: 8, build: 8, drop: 24, outro: 8 } }, 60);
  assert.equal(longer.totalBars, 48);

  const up = buildSong({ ...r, chop: { ...r.chop, shift: 12 } }, 60);
  const base = buildSong(r, 60);
  assert.equal(up.tracks.vox[5].midi - base.tracks.vox[5].midi, 12);
});

test('chop density and slice modes', () => {
  const r = rollRecipe('hype', 4);
  const count = (density) => buildSong({ ...r, chop: { ...r.chop, density } }, 60).hook.length;
  assert.ok(count('sparse') < count('normal'));
  assert.ok(count('busy') > count('normal'));
  const sliced = buildSong({ ...r, chop: { ...r.chop, mode: 'cycle' } }, 60);
  assert.ok(sliced.tracks.vox.every((e) => Number.isInteger(e.slice)));
  const whole = buildSong({ ...r, chop: { ...r.chop, mode: 'whole' } }, 60);
  assert.ok(whole.tracks.vox.every((e) => e.slice === undefined));
});

test('events know which chord they belong to (for live chords)', () => {
  const song = buildSong(rollRecipe('dark', 6), 60);
  for (const name of ['pad', 'bass', 'vox']) {
    for (const e of song.tracks[name]) assert.ok(e.chord >= 0 && e.chord < song.chords.length, `${name} at ${e.step}`);
  }
  for (const e of song.tracks.keys) assert.ok(e.chord >= 0 && e.chord < 4);
  assert.ok(song.chords.every((c) => Number.isInteger(c.root)));
});

test('song codes round-trip and reject junk', () => {
  const r = rollRecipe('epic', 77);
  const code = encodeRecipe(r);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeRecipe(code), r);
  assert.deepEqual(decodeRecipe(`  ${code}\n`), r);
  assert.equal(decodeRecipe('not a code'), null);
  assert.equal(decodeRecipe(encodeRecipe({ ...r, mood: 'polka' })), null);
  assert.equal(decodeRecipe(encodeRecipe({ ...r, bars: { ...r.bars, drop: 7 } })), null);
});
