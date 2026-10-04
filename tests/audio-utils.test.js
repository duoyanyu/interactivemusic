import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPitch,
  findVowelOffset,
  normalize,
  peak,
  synthDemoVoice,
  toMono,
  trimSilence,
} from '../src/audio-utils.js';

const SR = 44100;

function tone(freq, seconds, amp = 0.5) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const silence = (seconds) => new Float32Array(Math.round(seconds * SR));

test('trimSilence finds the word inside the silence', () => {
  const input = concat(silence(0.5), tone(220, 0.4), silence(0.8));
  const { samples, start, end, silent } = trimSilence(input, SR);
  assert.equal(silent, false);
  assert.ok(Math.abs(start / SR - 0.5) < 0.03, `start ${start / SR}`);
  assert.ok(Math.abs(end / SR - 0.9) < 0.08, `end ${end / SR}`);
  assert.equal(samples.length, end - start);
  // faded in and out, no clicks at the edges
  assert.ok(Math.abs(samples[0]) < 0.01);
  assert.ok(Math.abs(samples[samples.length - 1]) < 0.01);
});

test('trimSilence ignores a click far away from the word', () => {
  const click = new Float32Array(200).fill(0.3);
  const input = concat(silence(0.1), click, silence(0.9), tone(220, 0.3), silence(0.5));
  const { start } = trimSilence(input, SR);
  assert.ok(start / SR > 0.9, `start ${start / SR} included the click`);
});

test('trimSilence keeps short gaps inside a word', () => {
  const input = concat(silence(0.3), tone(200, 0.2), silence(0.08), tone(260, 0.2), silence(0.4));
  const { start, end } = trimSilence(input, SR);
  assert.ok((end - start) / SR > 0.45, `kept only ${(end - start) / SR}s`);
});

test('trimSilence reports pure silence', () => {
  assert.equal(trimSilence(silence(1), SR).silent, true);
});

test('detectPitch finds sine pitches', () => {
  for (const f of [98, 147, 220, 440, 660]) {
    const r = detectPitch(tone(f, 0.5), SR);
    assert.ok(r, `no pitch for ${f}`);
    assert.ok(Math.abs(r.freq - f) / f < 0.01, `${f} Hz read as ${r.freq}`);
  }
});

test('detectPitch handles the formant-heavy demo voice', () => {
  const r = detectPitch(synthDemoVoice(SR, { freq: 233.08 }), SR);
  assert.ok(r);
  assert.ok(Math.abs(r.freq - 233.08) / 233.08 < 0.015, `read ${r.freq}`);
});

test('detectPitch gives up on noise', () => {
  let seed = 7;
  const noise = new Float32Array(SR).map(() => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  });
  assert.equal(detectPitch(noise, SR), null);
});

test('normalize and toMono', () => {
  const n = normalize(tone(100, 0.1, 0.2), 0.9);
  assert.ok(Math.abs(peak(n) - 0.9) < 0.001);
  const mono = toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual(Array.from(mono), [0.5, 0.5]);
});

test('findVowelOffset lands just before the loud part', () => {
  const quiet = tone(3000, 0.15, 0.05);
  const loud = tone(220, 0.4, 0.8);
  const offset = findVowelOffset(concat(quiet, loud), SR);
  assert.ok(offset > 0.08 && offset < 0.16, `offset ${offset}`);
});
