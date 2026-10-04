import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutSlice, detectSlices, evenSlices, findOnsets, snapToZeroCrossing } from '../src/slicer.js';
import { normalize, synthDemoVoice, trimSilence } from '../src/audio-utils.js';

const SR = 44100;

// Deterministic noise, so every run sees the same signals.
function noiseSource(seed = 1) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
}

function tone(freq, seconds, amp = 0.5, rate = SR) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

const silence = (seconds, rate = SR) => new Float32Array(Math.round(seconds * rate));

// A decaying burst of white noise, like a "ts" or a hi-hat.
function hiss(seconds, { amp = 0.4, decay = 0.025, seed = 1, rate = SR } = {}) {
  const rand = noiseSource(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * rand() * Math.exp(-i / rate / decay);
  return out;
}

// A sung vowel: harmonics with a formant bump, vibrato, an amplitude envelope env(t) and an optional pitch change.
function voice(f0, seconds, { vibrato = 0.01, env = () => 1, pitch = () => 1, rate = SR } = {}) {
  const out = new Float32Array(Math.round(seconds * rate));
  const rand = noiseSource(7);
  let phase = 0;
  let weights = [];
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f = f0 * pitch(t) * (1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t));
    phase += (2 * Math.PI * f) / rate;
    if (i % 64 === 0) {
      weights = [];
      for (let h = 1; h * f < 5000; h++) weights.push((1 + 2 * Math.exp(-(((h * f - 700) / 300) ** 2))) / h ** 0.9);
    }
    let s = 0;
    for (let h = 0; h < weights.length; h++) s += weights[h] * Math.sin((h + 1) * phase);
    out[i] = 0.15 * s * env(t) + 0.002 * rand();
  }
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

// Smooth envelope that is 1 everywhere except a raised-cosine dip down to `depth` around each centre.
function dips(centres, { depth = 0.1, halfWidth = 0.04 } = {}) {
  return (t) => {
    let g = 1;
    for (const c of centres) {
      if (Math.abs(t - c) >= halfWidth) continue;
      g = Math.min(g, depth + (1 - depth) * (0.5 - 0.5 * Math.cos((Math.PI * (t - c)) / halfWidth)));
    }
    return g;
  };
}

const fadeInOut = (seconds, attack = 0.05, release = 0.12) => (t) =>
  Math.min(1, t / attack) * Math.max(0, Math.min(1, (seconds - t) / release));

const cutsOf = (slices) => slices.slice(1).map((s) => s.start);

function assertCoverage(slices, length, minLength = 0) {
  assert.ok(slices.length >= 1, 'at least one slice');
  assert.equal(slices[0].start, 0);
  assert.equal(slices[slices.length - 1].end, length);
  for (let i = 0; i < slices.length; i++) {
    const { start, end } = slices[i];
    assert.ok(Number.isInteger(start) && Number.isInteger(end), `integer bounds ${start}..${end}`);
    if (slices.length > 1) assert.ok(end - start >= minLength, `slice ${i} is ${end - start} samples`);
    if (i > 0) assert.equal(start, slices[i - 1].end, 'contiguous');
  }
}

function assertNear(actual, expected, toleranceSec, rate = SR, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= toleranceSec * rate,
    `${label} cut at ${(actual / rate).toFixed(4)}s, expected ${(expected / rate).toFixed(4)}s`,
  );
}

const beatbox = (rate = SR) => {
  const kick = (sec) => {
    const out = new Float32Array(Math.round(sec * rate));
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      out[i] = 0.8 * Math.sin(2 * Math.PI * (60 * t + 2.4 * (1 - Math.exp(-t / 0.03)))) * Math.exp(-t / 0.12);
    }
    return out;
  };
  const snare = (sec, seed) => {
    const body = tone(190, sec, 0.3, rate);
    return hiss(sec, { amp: 0.4, decay: 0.06, seed, rate }).map((v, i) => v + body[i] * Math.exp(-i / rate / 0.05));
  };
  const hat = (sec, seed) => hiss(sec, { amp: 0.3, decay: 0.025, seed, rate });
  // boots-ts-cats-ts boots boots-ts-cats
  const parts = [kick(0.25), hat(0.25, 2), snare(0.25, 3), hat(0.125, 4), kick(0.125), kick(0.25), hat(0.25, 5),
    snare(0.3, 6)];
  const starts = [];
  let at = 0;
  for (const p of parts) {
    starts.push(at);
    at += p.length;
  }
  return { samples: concat(...parts), starts: starts.slice(1) };
};

test('silence-separated bursts give one slice per burst, cut at their starts', () => {
  for (const rate of [44100, 48000]) {
    const bursts = [tone(220, 0.2, 0.5, rate), tone(330, 0.2, 0.4, rate), tone(262, 0.25, 0.6, rate)];
    const gap = silence(0.1, rate);
    const samples = concat(bursts[0], gap, bursts[1], gap, bursts[2]);
    const slices = detectSlices(samples, rate);
    assertCoverage(slices, samples.length);
    assert.equal(slices.length, 3, `${rate} Hz: ${slices.length} slices`);
    assertNear(slices[1].start, bursts[0].length + gap.length, 0.015, rate, `${rate} Hz`);
    assertNear(slices[2].start, bursts[0].length + bursts[1].length + 2 * gap.length, 0.015, rate, `${rate} Hz`);
  }
});

test('a continuous tone with dips between syllables splits at the dips', () => {
  const env = dips([0.3, 0.6]);
  const samples = tone(220, 0.9).map((v, i) => v * env(i / SR));
  const slices = detectSlices(samples, SR);
  assertCoverage(slices, samples.length);
  assert.equal(slices.length, 3);
  // inside the dip, where the level is still below half
  assertNear(slices[1].start, 0.3 * SR, 0.018);
  assertNear(slices[2].start, 0.6 * SR, 0.018);
});

test('a sung "la-la-la" splits at the dips between syllables', () => {
  const seconds = 1.2;
  const shape = dips([0.4, 0.8], { depth: 0.2, halfWidth: 0.05 });
  const fade = fadeInOut(seconds);
  const samples = voice(196, seconds, { env: (t) => shape(t) * fade(t) });
  const slices = detectSlices(samples, SR);
  assertCoverage(slices, samples.length);
  assert.equal(slices.length, 3);
  assertNear(slices[1].start, 0.4 * SR, 0.025);
  assertNear(slices[2].start, 0.8 * SR, 0.025);
});

test('a "ts" burst followed by a tone is cut at the burst, and the hiss stays with its tone', () => {
  const before = tone(220, 0.3);
  const samples = concat(before, hiss(0.05), tone(220, 0.3));
  const slices = detectSlices(samples, SR);
  assertCoverage(slices, samples.length);
  assert.equal(slices.length, 2);
  assertNear(slices[1].start, before.length, 0.015);
});

test('a beatbox sequence is cut at every hit', () => {
  for (const rate of [44100, 48000]) {
    const { samples, starts } = beatbox(rate);
    const slices = detectSlices(samples, rate);
    assertCoverage(slices, samples.length);
    assert.equal(slices.length, starts.length + 1);
    cutsOf(slices).forEach((cut, i) => assertNear(cut, starts[i], 0.015, rate, `hit ${i + 1}`));
  }
});

test('a single held vowel stays one slice', () => {
  const held = [
    voice(200, 1.5, { env: fadeInOut(1.5) }),
    // a singer's vibrato with a wobble in level too
    voice(260, 1.6, { vibrato: 0.03, env: (t) => (1 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t)) * fadeInOut(1.6)(t) }),
    // a slow swell
    voice(220, 2, { env: (t) => (0.1 + 0.45 * t) * fadeInOut(2, 0.02, 0.1)(t) }),
    normalize(trimSilence(synthDemoVoice(SR), SR).samples),
  ];
  held.forEach((samples, i) => assert.equal(detectSlices(samples, SR).length, 1, `vowel ${i}`));

  // and so does a long steady "shhh"
  const rand = noiseSource(3);
  const shh = new Float32Array(SR).map((_, i) => 0.4 * rand() * fadeInOut(1, 0.08, 0.1)(i / SR));
  assert.equal(detectSlices(shh, SR).length, 1, 'shhh');
});

test('a clear jump between two held notes is a cut, a glide is not', () => {
  const jump = voice(200, 1, { pitch: (t) => (t < 0.5 ? 1 : 1.5), env: fadeInOut(1) });
  const slices = detectSlices(jump, SR);
  assert.equal(slices.length, 2);
  assertNear(slices[1].start, 0.5 * SR, 0.02);

  // a fifth, but sliding there over 400 ms
  const slide = (t) => 2 ** ((Math.min(1, Math.max(0, (t - 0.3) / 0.4)) * 7) / 12);
  const glide = voice(200, 1, { pitch: slide, env: fadeInOut(1) });
  assert.equal(detectSlices(glide, SR).length, 1);
});

test('maxSlices keeps the strongest onsets', () => {
  const { samples, starts } = beatbox();
  for (const maxSlices of [1, 2, 4, 6]) {
    const slices = detectSlices(samples, SR, { maxSlices });
    assertCoverage(slices, samples.length);
    assert.equal(slices.length, maxSlices);
    for (const cut of cutsOf(slices)) {
      assert.ok(starts.some((s) => Math.abs(cut - s) <= 0.015 * SR), `cut ${cut / SR} is not at a hit`);
    }
  }
  assert.equal(detectSlices(samples, SR, { maxSlices: 0 }).length, 1);
  // strongest first: with room for two cuts, the two snares get them
  const cuts = cutsOf(detectSlices(samples, SR, { maxSlices: 3 }));
  assert.deepEqual(cuts.map((c) => starts.findIndex((s) => Math.abs(c - s) <= 0.015 * SR)), [1, 6]);
});

test('minSliceSec merges onsets that are too close', () => {
  const { samples } = beatbox();
  for (const minSliceSec of [0.06, 0.2, 0.3]) {
    const slices = detectSlices(samples, SR, { minSliceSec });
    assertCoverage(slices, samples.length, Math.round(minSliceSec * SR));
  }
  assert.ok(detectSlices(samples, SR, { minSliceSec: 0.3 }).length < detectSlices(samples, SR).length);
});

test('higher sensitivity gives more slices', (t) => {
  // dips from shallow (-6 dB) to deep (-30 dB)
  const depths = [0.5, 0.35, 0.25, 0.12, 0.03];
  const centres = depths.map((_, i) => 0.3 + i * 0.3);
  const env = (t) => Math.min(...depths.map((d, i) => dips([centres[i]], { depth: d, halfWidth: 0.05 })(t)));
  const samples = voice(180, 1.8, { env: (t) => env(t) * fadeInOut(1.8)(t) });
  const counts = [0, 0.25, 0.5, 0.75, 1].map((sensitivity) => detectSlices(samples, SR, { sensitivity }).length);
  t.diagnostic(`slices at sensitivity 0, 0.25, 0.5, 0.75, 1: ${counts}`);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `counts ${counts}`);
  assert.ok(counts[0] < counts[4], `counts ${counts}`);
  assert.equal(counts[4], depths.length + 1, `counts ${counts}`);
});

test('slices are sorted, contiguous and cover the clip for all kinds of input', () => {
  const rand = noiseSource(11);
  const clicks = new Float32Array(SR * 2);
  for (let i = 0; i < clicks.length; i++) clicks[i] = 0.01 * rand() + (i % 3907 < 30 ? 0.7 * rand() : 0);
  const inputs = [
    beatbox().samples,
    concat(tone(220, 0.2), silence(0.1), tone(330, 0.2)),
    voice(150, 2, { env: dips([0.5, 1, 1.5], { depth: 0.05 }) }),
    clicks,
    hiss(0.5, { decay: 10 }),
  ];
  for (const samples of inputs) {
    for (const opts of [{}, { sensitivity: 1 }, { sensitivity: 0 }, { maxSlices: 3 }, { minSliceSec: 0.01 }]) {
      const slices = detectSlices(samples, SR, opts);
      assertCoverage(slices, samples.length, Math.round((opts.minSliceSec ?? 0.06) * SR));
      assert.ok(slices.length <= (opts.maxSlices ?? 8));
    }
  }
});

test('cuts land on zero crossings', () => {
  const env = dips([0.3, 0.6]);
  const samples = tone(220, 0.9).map((v, i) => v * env(i / SR));
  for (const cut of cutsOf(detectSlices(samples, SR))) {
    assert.ok(samples[cut] === 0 || samples[cut - 1] * samples[cut] < 0, `no crossing at ${cut}`);
  }
});

test('findOnsets reports onsets in time order with a strength', () => {
  const { samples, starts } = beatbox();
  const onsets = findOnsets(samples, SR);
  for (let i = 1; i < onsets.length; i++) assert.ok(onsets[i].index >= onsets[i - 1].index);
  for (const start of starts) {
    assert.ok(onsets.some((o) => Math.abs(o.index - start) <= 0.015 * SR && o.strength > 0), `missed ${start / SR}`);
  }
});

test('evenSlices splits a length into equal parts', () => {
  assert.deepEqual(evenSlices(100, 4), [
    { start: 0, end: 25 },
    { start: 25, end: 50 },
    { start: 50, end: 75 },
    { start: 75, end: 100 },
  ]);
  assert.deepEqual(evenSlices(10, 3), [
    { start: 0, end: 3 },
    { start: 3, end: 7 },
    { start: 7, end: 10 },
  ]);
  assert.deepEqual(evenSlices(44100, 1), [{ start: 0, end: 44100 }]);
  assert.deepEqual(evenSlices(0, 4), [{ start: 0, end: 0 }]);
  assert.equal(evenSlices(3, 8).length, 3);
  assert.equal(evenSlices(100, 0).length, 1);
  assertCoverage(evenSlices(12345, 7), 12345);
});

test('cutSlice copies a slice with short fades', () => {
  const samples = new Float32Array(SR).fill(0.5);
  const slice = { start: 1000, end: 11000 };
  const out = cutSlice(samples, slice, SR);
  assert.equal(out.length, 10000);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 0);
  assert.ok(Math.abs(out[1]) < 0.01 && Math.abs(out[out.length - 2]) < 0.01, 'starts and ends near zero');
  // linear 3 ms fade in, 15 ms fade out, untouched in between
  const fi = Math.round(0.003 * SR);
  const fo = Math.round(0.015 * SR);
  assert.ok(Math.abs(out[fi / 2 | 0] - 0.5 * ((fi / 2 | 0) / fi)) < 1e-6);
  assert.equal(out[fi], 0.5);
  assert.equal(out[out.length - 1 - fo], 0.5);
  assert.ok(out[out.length - 1 - (fo >> 1)] < 0.26);
  for (let i = 1; i < fi; i++) assert.ok(out[i] >= out[i - 1], 'fade in rises');
  // a copy: the source is untouched
  out[5000] = 9;
  assert.equal(samples[slice.start + 5000], 0.5);

  assert.equal(cutSlice(samples, { start: 500, end: 500 }, SR).length, 0);
  assert.equal(cutSlice(samples, { start: -50, end: 100 }, SR).length, 100);
  assert.equal(cutSlice(samples, { start: SR - 10, end: SR + 500 }, SR).length, 10);
  // shorter than the fades: still silent at both ends
  const tiny = cutSlice(samples, { start: 0, end: 200 }, SR);
  assert.equal(tiny.length, 200);
  assert.equal(tiny[0], 0);
  assert.equal(tiny[199], 0);
  assert.ok(Math.max(...tiny) <= 0.5);
});

test('snapToZeroCrossing moves to the nearest crossing within reach', () => {
  const samples = tone(100, 0.1);
  const crosses = (j) => samples[j] === 0 || samples[j - 1] * samples[j] < 0;
  for (const index of [300, 441, 500, 650, 880]) {
    let nearest = index;
    for (let d = 0; d <= 60; d++) {
      if (crosses(index - d)) {
        nearest = index - d;
        break;
      }
      if (crosses(index + d)) {
        nearest = index + d;
        break;
      }
    }
    assert.equal(snapToZeroCrossing(samples, index, 60), nearest, `from ${index}`);
  }
  const odd = new Float32Array([0.5, 0.4, 0.2, -0.1, -0.3, -0.2, 0.1, 0.3]);
  assert.equal(snapToZeroCrossing(odd, 1, 3), 3);
  assert.equal(snapToZeroCrossing(odd, 5, 3), 6);
  assert.equal(snapToZeroCrossing(odd, 4, 1), 3, 'the earlier one wins a tie');
  assert.equal(snapToZeroCrossing(new Float32Array([0.2, 0, 0.3, 0.1]), 3, 2), 1, 'an exact zero counts');
  // nothing within reach: stays put
  assert.equal(snapToZeroCrossing(odd, 1, 1), 1);
  assert.equal(snapToZeroCrossing(new Float32Array(100).fill(0.3), 50, 40), 50);
  // out of range indices are clamped
  assert.equal(snapToZeroCrossing(samples, -10, 5), 0);
  assert.equal(snapToZeroCrossing(samples, samples.length + 10, 5), samples.length);
});

test('edge cases never throw', () => {
  assert.deepEqual(detectSlices(new Float32Array(0), SR), [{ start: 0, end: 0 }]);
  assert.deepEqual(detectSlices(new Float32Array(10), SR), [{ start: 0, end: 10 }]);
  assert.deepEqual(detectSlices(tone(220, 0.05), SR), [{ start: 0, end: Math.round(0.05 * SR) }]);
  assert.deepEqual(detectSlices(new Float32Array(SR), SR), [{ start: 0, end: SR }]);
  assert.deepEqual(detectSlices(new Float32Array(SR).fill(0.2), SR), [{ start: 0, end: SR }]);
  assert.deepEqual(findOnsets(new Float32Array(0), SR), []);
  assert.deepEqual(findOnsets(new Float32Array(SR), SR), []);
  // a plain array, a missing sample rate and odd options are fine too
  assertCoverage(detectSlices(Array.from(beatbox().samples), undefined), beatbox().samples.length);
  assertCoverage(detectSlices(beatbox().samples, SR, { maxSlices: NaN, minSliceSec: -1, sensitivity: 7 }),
    beatbox().samples.length);
  const broken = tone(220, 0.5);
  broken[1000] = NaN;
  assertCoverage(detectSlices(broken, SR), broken.length);
  assert.equal(cutSlice(new Float32Array(0), { start: 0, end: 0 }, SR).length, 0);
});

test('a 3 s clip slices quickly', (t) => {
  const rate = 48000;
  const seconds = 3;
  const syllables = Array.from({ length: 7 }, (_, i) => 0.4 + i * 0.35);
  const shape = dips(syllables, { depth: 0.05 });
  const fade = fadeInOut(seconds);
  const sung = voice(170, seconds, { rate, env: (time) => shape(time) * fade(time) });
  // plus a "ts" every 350 ms
  const ts = hiss(0.04, { rate });
  const samples = sung.map((v, i) => v + (i % 16800 < ts.length ? ts[i % 16800] : 0));
  const first = performance.now();
  const slices = detectSlices(samples, rate);
  const firstMs = performance.now() - first;
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    detectSlices(samples, rate);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`3 s at 48 kHz: ${slices.length} slices, first call ${firstMs.toFixed(1)} ms, ` +
    `then ${times[2].toFixed(1)} ms`);
  assertCoverage(slices, samples.length);
  assert.ok(times[2] < 50, `took ${times[2].toFixed(1)} ms`);
});
