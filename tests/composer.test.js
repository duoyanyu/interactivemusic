import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROOVES, MOOD_IDS, applyVoice, generateSong, STEPS_PER_BAR } from '../src/composer.js';
import { SCALES, mod } from '../src/theory.js';

const SEEDS = [1, 7, 42, 1234, 99999, 3141592653];

const inKey = (song, midi) => {
  const pcs = SCALES[song.mode].map((i) => mod(song.tonicPc + i, 12));
  return pcs.includes(mod(midi, 12));
};

test('same seed and mood give the same song', () => {
  const a = generateSong({ mood: 'hype', seed: 42, voiceRoot: 57 });
  const b = generateSong({ mood: 'hype', seed: 42, voiceRoot: 57 });
  assert.deepEqual(a, b);
  const c = generateSong({ mood: 'hype', seed: 43, voiceRoot: 57 });
  assert.notDeepEqual(a.tracks.vox, c.tracks.vox);
});

for (const mood of MOOD_IDS) {
  test(`${mood}: sections run intro, build, drop, outro back to back`, () => {
    for (const seed of SEEDS) {
      const song = generateSong({ mood, seed, voiceRoot: 60 });
      const ids = song.sections.map((s) => s.id);
      const expected = song.recipe.form === 'double'
        ? ['intro', 'build', 'drop', 'breakdown', 'build', 'drop', 'outro']
        : ['intro', 'build', 'drop', 'outro'];
      assert.deepEqual(ids, expected);
      let step = 0;
      for (const s of song.sections) {
        assert.equal(s.startStep, step);
        assert.equal(s.bars % 4, 0, 'sections are whole phrases');
        step = s.endStep;
      }
      assert.equal(step, song.totalSteps);
      assert.equal(song.totalBars * STEPS_PER_BAR, song.totalSteps);
      const range = GROOVES[song.style.groove].bpm;
      assert.ok(song.bpm >= range[0] && song.bpm <= range[1]);
      assert.ok(song.durationSec > 30 && song.durationSec < 200, `${song.durationSec}s`);
    }
  });

  test(`${mood}: chords, bass and chops stay in key`, () => {
    for (const seed of SEEDS) {
      const song = generateSong({ mood, seed, voiceRoot: 55 });
      for (const e of [...song.tracks.pad, ...song.tracks.keys]) {
        for (const n of e.notes) assert.ok(inKey(song, n), `${song.key}: chord note ${n} off key`);
      }
      for (const e of song.tracks.bass) assert.ok(inKey(song, e.note), `${song.key}: bass ${e.note}`);
      for (const e of song.tracks.vox) assert.ok(inKey(song, e.midi), `${song.key}: vox ${e.midi}`);
    }
  });

  test(`${mood}: every event lands inside the song`, () => {
    for (const seed of SEEDS) {
      const song = generateSong({ mood, seed });
      for (const [name, events] of Object.entries(song.tracks)) {
        for (const e of events) {
          assert.ok(e.step >= 0 && e.step < song.totalSteps, `${name} at ${e.step}`);
          assert.ok(Number.isInteger(e.step * 2), `${name} step ${e.step} is off the 32nd grid`);
          if ('vel' in e) assert.ok(e.vel > 0 && e.vel <= 1, `${name} vel ${e.vel}`);
          if ('dur' in e) assert.ok(e.dur > 0, `${name} dur ${e.dur}`);
        }
      }
      for (const name of ['kick', 'snare', 'roll', 'hat', 'ohat', 'crash', 'bass']) {
        const steps = song.tracks[name].map((e) => e.step);
        assert.equal(new Set(steps).size, steps.length, `${name} has two hits at one instant`);
      }
      assert.ok(song.tracks.vox.length > 20, 'the hook should actually play');
    }
  });

  test(`${mood}: chops sit near the voice so they don't turn into chipmunks`, () => {
    for (const voiceRoot of [45, 57, 69]) {
      for (const seed of SEEDS) {
        const song = generateSong({ mood, seed, voiceRoot });
        for (const e of song.tracks.vox) {
          const shift = e.midi - voiceRoot;
          assert.ok(shift >= -16 && shift <= 21, `${mood} root ${voiceRoot}: chop ${e.midi} is ${shift} semitones away`);
        }
      }
    }
  });
}

test('the drop has the most going on', () => {
  for (const mood of MOOD_IDS) {
    const song = generateSong({ mood, seed: 5 });
    const density = (id) => {
      const s = song.sections.find((x) => x.id === id);
      const count = Object.values(song.tracks)
        .flat()
        .filter((e) => e.step >= s.startStep && e.step < s.endStep).length;
      return count / s.bars;
    };
    assert.ok(density('drop') > density('intro'), `${mood}: drop thinner than intro`);
    assert.ok(density('drop') > density('outro'), `${mood}: drop thinner than outro`);
  }
});

test('applyVoice only moves the vocal chops', () => {
  const song = generateSong({ mood: 'dreamy', seed: 11, voiceRoot: 57 });
  const moved = applyVoice(song, 64);
  assert.deepEqual(moved.tracks.pad, song.tracks.pad);
  assert.deepEqual(moved.tracks.kick, song.tracks.kick);
  assert.equal(moved.tracks.vox.length, song.tracks.vox.length);
  const diffs = new Set(moved.tracks.vox.map((e, i) => e.midi - song.tracks.vox[i].midi));
  assert.equal(diffs.size, 1, 'every chop shifts by the same octave-ish amount');
});
