import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROOVES, HOOK_RHYTHMS, KEYS_STYLES, MOODS, DEFAULT_PROGRESSIONS } from '../src/moods.js';
import { BASS_PATCHES, KITS, PAD_PATCHES, PERC_SOUNDS, PLUCK_PATCHES, TEXTURES } from '../src/patches.js';
import { SCALES, chordQuality } from '../src/theory.js';

const PATTERN = /^[.0-9]{16}$/;
const BASS_PATTERN = /^[.Rr5O]{16}$/;
const HOOK = /^[.x]{16}$/;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

test('grooves are well formed', () => {
  for (const [id, g] of Object.entries(GROOVES)) {
    for (const part of ['kick', 'snare', 'hat', 'ohat']) assert.match(g[part], PATTERN, `${id}.${part}`);
    if (g.perc) assert.match(g.perc, PATTERN, `${id}.perc`);
    assert.ok(g.bass.length >= 1);
    for (const b of g.bass) assert.match(b, BASS_PATTERN, `${id}.bass`);
    assert.ok(g.bpm[0] <= g.bpm[1] && g.bpm[0] >= 60 && g.bpm[1] <= 180, `${id}.bpm`);
    assert.ok(g.swing[0] <= g.swing[1] && g.swing[1] <= 0.35, `${id}.swing`);
    assert.ok(KITS[g.kit], `${id}.kit "${g.kit}"`);
    if (g.bassPatch) assert.ok(BASS_PATCHES[g.bassPatch], `${id}.bassPatch`);
    assert.ok(g.bassMax >= 1 && g.bassMax <= 16);
    assert.equal(typeof g.name, 'string');
  }
});

test('hook rhythms are well formed', () => {
  for (const [id, h] of Object.entries(HOOK_RHYTHMS)) {
    assert.ok(h.call.length >= 2 && h.answer.length >= 2, id);
    for (const r of [...h.call, ...h.answer]) {
      assert.match(r, HOOK, `${id}: ${r}`);
      assert.ok(r.includes('x'), `${id}: empty rhythm`);
    }
  }
});

test('every mood references real things and only plays major/minor chords', () => {
  for (const [id, m] of Object.entries(MOODS)) {
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.blurb, 'string');
    assert.match(m.colors.dark, /^#[0-9a-f]{6}$/i);
    assert.match(m.colors.light, /^#[0-9a-f]{6}$/i);
    assert.ok(contrast(m.colors.dark, '#1e1e22') >= 4.5, `${id} dark colour contrast`);
    assert.ok(contrast(m.colors.light, '#edece8') >= 3.2, `${id} light colour contrast`);
    for (const mode of m.modes) {
      assert.ok(SCALES[mode], `${id} mode ${mode}`);
      assert.ok(m.progressions[mode]?.length, `${id} has progressions for ${mode}`);
    }
    for (const [mode, progs] of Object.entries(m.progressions)) {
      for (const p of progs) {
        assert.equal(p.length, 4, `${id} ${mode} progression ${p}`);
        for (const root of p) {
          const q = chordQuality(SCALES[mode], root);
          assert.ok(q === 'major' || q === 'minor', `${id} ${mode}: degree ${root} is ${q}`);
        }
      }
    }
    for (const g of m.grooves) assert.ok(GROOVES[g], `${id} groove ${g}`);
    for (const p of m.pads) assert.ok(PAD_PATCHES[p], `${id} pad ${p}`);
    for (const p of m.plucks) assert.ok(PLUCK_PATCHES[p], `${id} pluck ${p}`);
    for (const b of m.basses) assert.ok(BASS_PATCHES[b], `${id} bass ${b}`);
    for (const k of m.kits) assert.ok(KITS[k], `${id} kit ${k}`);
    for (const k of m.keysStyles) assert.ok(KEYS_STYLES[k], `${id} keys style ${k}`);
    for (const t of m.texture) assert.ok(TEXTURES[t], `${id} texture ${t}`);
    for (const part of ['intro', 'build', 'drop', 'outro']) {
      assert.ok(m.bars[part].length, `${id} bars.${part}`);
      for (const n of m.bars[part]) assert.ok(n % 4 === 0 && n >= 4 && n <= 24, `${id} bars.${part} = ${n}`);
    }
    assert.ok(['none', 'hats', 'light'].includes(m.introDrums), `${id} introDrums`);
    assert.ok(HOOK_RHYTHMS[m.hook.style], `${id} hook style`);
    assert.ok(m.hook.low <= 0 && m.hook.high >= 5 && m.hook.high <= 9, `${id} hook range`);
    assert.ok(m.hook.maxLen >= 1 && m.hook.maxLen <= 8);
    assert.ok(m.hook.gate[0] <= m.hook.gate[1] && m.hook.gate[1] <= 1);
    assert.ok(m.pump[0] <= m.pump[1] && m.pump[1] <= 0.9);
    assert.ok(m.melodyLift >= -3 && m.melodyLift <= 7);
    assert.ok(m.energy > 0 && m.energy <= 1);
    assert.ok(m.padFilter[0] < m.padFilter[1]);
    for (const k of ['reverb', 'size', 'delay', 'feedback']) {
      assert.ok(m.fx[k][0] <= m.fx[k][1] && m.fx[k][0] >= 0 && m.fx[k][1] <= 100, `${id} fx.${k}`);
    }
    for (const k of ['stutter', 'harmony', 'octave', 'vowel']) assert.ok(m.chop[k] >= 0 && m.chop[k] <= 1);
  }
});

test('default progressions avoid diminished chords', () => {
  for (const [mode, progs] of Object.entries(DEFAULT_PROGRESSIONS)) {
    assert.ok(SCALES[mode], mode);
    for (const p of progs) for (const root of p) {
      const q = chordQuality(SCALES[mode], root);
      assert.ok(q === 'major' || q === 'minor', `${mode}: degree ${root} is ${q}`);
    }
  }
  for (const mode of Object.keys(SCALES)) assert.ok(DEFAULT_PROGRESSIONS[mode], `fallback for ${mode}`);
});

test('patches use voices and sounds the engine knows', () => {
  for (const [id, p] of Object.entries(PAD_PATCHES)) {
    assert.equal(typeof p.label, 'string');
    assert.match(p.oscillator.type, /^(fat|am|fm)?(sine|square|sawtooth|triangle)$/, `pad ${id}`);
    assert.ok(p.volume <= 0 && p.chorus >= 0 && p.chorus <= 1, `pad ${id}`);
  }
  for (const [id, p] of Object.entries(PLUCK_PATCHES)) {
    assert.ok(['Synth', 'FMSynth', 'AMSynth', 'MonoSynth'].includes(p.voice), `pluck ${id}`);
    assert.ok(p.cutoff > 200 && p.volume <= 0, `pluck ${id}`);
  }
  for (const [id, p] of Object.entries(BASS_PATCHES)) {
    assert.ok(['MonoSynth', 'MembraneSynth', 'Synth', 'FMSynth'].includes(p.voice), `bass ${id}`);
    assert.ok(p.volume <= 0, `bass ${id}`);
  }
  for (const [id, k] of Object.entries(KITS)) {
    assert.ok(['snare', 'clap', 'rim'].includes(k.snare), `kit ${id} snare`);
    assert.ok(PERC_SOUNDS[k.perc], `kit ${id} perc`);
    assert.ok(k.kick.octaves >= 1 && k.kick.decay > 0 && typeof k.kick.note === 'string', `kit ${id} kick`);
    assert.ok(k.hat.decay > 0 && k.ohat.decay > 0 && k.hat.cutoff > 1000, `kit ${id} hats`);
    assert.ok(k.space >= 0 && k.space <= 1);
  }
});
