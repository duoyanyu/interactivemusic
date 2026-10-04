// Turns a recipe (every musical choice, spelled out) plus the voice's pitch
// into a full arrangement: chords, drums, bass, keys and a vocal-chop
// melody laid out over intro / build / drop / outro. Pure data, no audio,
// so it can be tested and drawn before any sound plays.
//
// rollRecipe(mood, seed) makes the choices; buildSong(recipe) plays them
// out. The studio panel edits recipes directly, and locks copy groups of
// fields from the old recipe into a freshly rolled one.

import { createRng } from './rng.js';
import {
  SCALES,
  chordDegrees,
  chordPcs,
  chordQuality,
  chordSymbol,
  romanNumeral,
  voiceChord,
  degreeToMidi,
  keyName,
  usesFlats,
  mod,
} from './theory.js';
import { DEFAULT_PROGRESSIONS, FILLS, GROOVES, HOOK_RHYTHMS, KEYS_RHYTHMS, MOODS, MOOD_IDS } from './moods.js';

export { GROOVES, MOODS, MOOD_IDS };

export const STEPS_PER_BAR = 16;
export const TAIL_SECONDS = 3.5;

// Fields of a recipe, grouped the way the studio panel locks them.
export const RECIPE_GROUPS = {
  harmony: ['tonic', 'mode', 'progression', 'chordSize'],
  groove: ['groove', 'bpm', 'swing', 'kit', 'pump'],
  sounds: ['pad', 'pluck', 'keys', 'bass', 'texture'],
  chops: ['chop', 'melodySeed'],
  structure: ['bars', 'form'],
  fx: ['fx'],
};

export const CHOP_MODES = { whole: 'Whole word', cycle: 'Slices in order', random: 'Random slices' };
export const DENSITIES = { sparse: 'Sparse', normal: 'Normal', busy: 'Busy' };
export const FORMS = { single: 'One drop', double: 'Two drops + breakdown' };

function hits(pattern) {
  const out = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c !== '.') out.push({ step: i, char: c, vel: /\d/.test(c) ? Number(c) / 9 : 1 });
  }
  return out;
}

const round = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// A stable sub-seed, so each part of a recipe can be re-rolled on its own.
export function subSeed(seed, salt) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h ^ salt.charCodeAt(i), 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

function nearestChordTone(deg, tones) {
  for (let d = 0; d < 7; d++) {
    if (tones.has(mod(deg - d, 7))) return deg - d;
    if (tones.has(mod(deg + d, 7))) return deg + d;
  }
  return deg;
}

function intoRange(deg, low, high) {
  while (deg > high) deg -= 7;
  while (deg < low) deg += 7;
  return deg;
}

// Where the melody's tonic sits. The hook mostly lives a few scale steps
// above the tonic, so aim the tonic ~5 semitones under the voice: the chops
// then hover around the word's natural pitch (plus a mood-dependent lift)
// instead of turning everyone into a chipmunk.
export function melodyTonicFor(tonicPc, voiceRoot, lift = 0) {
  const target = clamp(Math.round(voiceRoot) + lift - 5, 40, 72);
  let best = 0;
  for (let m = 36; m <= 84; m++) {
    if (mod(m, 12) === mod(tonicPc, 12) && (best === 0 || Math.abs(m - target) < Math.abs(best - target))) best = m;
  }
  return best;
}

// Progressions on offer for a mood in a given scale.
export function progressionsFor(mood, mode) {
  return MOODS[mood]?.progressions[mode] ?? DEFAULT_PROGRESSIONS[mode] ?? DEFAULT_PROGRESSIONS.minor;
}

// Chord names for a progression in a key, for menus and readouts.
export function describeProgression(tonic, mode, progression, size = 3) {
  const scale = SCALES[mode];
  const flats = usesFlats(tonic, mode);
  return progression.map((root) => {
    const s = chordQuality(scale, root) === 'dim' ? 3 : size;
    return { symbol: chordSymbol(tonic, scale, root, s, flats), roman: romanNumeral(scale, root) };
  });
}

export function rollRecipe(mood, seed, { keep = null, locks = [] } = {}) {
  const id = MOODS[mood] ? mood : 'hype';
  const M = MOODS[id];
  const rng = createRng(seed);
  const mode = rng.pick(M.modes);
  const groove = rng.pick(M.grooves);
  const G = GROOVES[groove];
  const recipe = {
    mood: id,
    seed,
    tonic: rng.int(0, 11),
    mode,
    progression: [...rng.pick(progressionsFor(id, mode))],
    chordSize: rng.chance(M.ninthChance) ? 5 : rng.chance(M.seventhChance) ? 4 : 3,
    groove,
    bpm: rng.int(G.bpm[0], G.bpm[1]),
    swing: round(rng.float(G.swing[0], G.swing[1])),
    kit: M.kits.includes(G.kit) && rng.chance(0.6) ? G.kit : rng.pick(M.kits),
    pump: round(rng.float(M.pump[0], M.pump[1]), 2),
    pad: rng.pick(M.pads),
    pluck: rng.pick(M.plucks),
    keys: rng.pick(M.keysStyles),
    bass: G.bassPatch ?? rng.pick(M.basses),
    texture: rng.pick(M.texture),
    chop: {
      mode: rng.chance(0.3) ? 'cycle' : 'whole',
      shift: 0,
      density: 'normal',
      gate: round(rng.float(M.hook.gate[0], M.hook.gate[1]), 2),
      start: rng.chance(M.chop.vowel) ? 'vowel' : 'start',
      stutter: rng.chance(M.chop.stutter * 2),
      harmony: rng.chance(M.chop.harmony),
      octave: rng.chance(M.chop.octave),
    },
    bars: {
      intro: rng.pick(M.bars.intro),
      build: rng.pick(M.bars.build),
      drop: rng.pick(M.bars.drop),
      outro: rng.pick(M.bars.outro),
    },
    fx: {
      reverb: rng.int(M.fx.reverb[0], M.fx.reverb[1]),
      size: rng.int(M.fx.size[0], M.fx.size[1]),
      delay: rng.int(M.fx.delay[0], M.fx.delay[1]),
      feedback: rng.int(M.fx.feedback[0], M.fx.feedback[1]),
    },
    melodySeed: subSeed(seed, 'melody'),
    detailSeed: subSeed(seed, 'detail'),
  };
  // longer songs with a breakdown and a second drop, now and then
  recipe.form = rng.chance(0.35) ? 'double' : 'single';
  if (keep) {
    for (const group of locks) {
      for (const field of RECIPE_GROUPS[group] ?? []) {
        if (keep[field] !== undefined) recipe[field] = structuredClone(keep[field]);
      }
    }
  }
  return recipe;
}

function makeHook(rng, M, chords, { density = 'normal', sliceMode = 'whole' } = {}) {
  const H = M.hook;
  const R = HOOK_RHYTHMS[H.style] ?? HOOK_RHYTHMS.hype;
  const call = rng.pick(R.call);
  const answer = rng.pick(R.answer);
  const lastAnswer = rng.chance(0.5) ? rng.pick(R.answer) : answer;
  const rhythm = [call, answer, call, lastAnswer];
  const center = rng.pick([1, 2, 3]);
  const tonesOf = (chord) => new Set(chord.degrees.map((d) => mod(d, 7)));

  let notes = [];
  let prev = nearestChordTone(center, tonesOf(chords[0]));

  const pickNext = (prevDeg, tones, strong) => {
    const entries = [];
    for (let c = H.low; c <= H.high; c++) {
      const dist = Math.abs(c - prevDeg);
      let w = [0.6, 3, 2, 1, 0.6, 0.3, 0.2, 0.2][Math.min(dist, 7)];
      if (tones.has(mod(c, 7))) w *= strong ? 4 : 1.6;
      else if (strong) w *= 0.25;
      w *= Math.exp(-Math.abs(c - center) / 5);
      entries.push([c, w]);
    }
    return rng.weighted(entries);
  };

  for (let b = 0; b < 4; b++) {
    const tones = tonesOf(chords[b]);
    if (b === 2) {
      // Repeat bar 1's shape, moved to fit the third chord (a "sequence").
      const bar0 = notes.filter((n) => n.step < 16);
      let shift = mod(chords[2].root - chords[0].root + 3, 7) - 3;
      const fits = (s) => bar0.filter((n) => n.deg + s >= H.low && n.deg + s <= H.high).length;
      shift = [shift, shift - 7, shift + 7].sort((a, z) => fits(z) - fits(a) || Math.abs(a) - Math.abs(z))[0];
      for (const n of bar0) {
        let deg = n.deg + shift;
        if (n.strong && !tones.has(mod(deg, 7))) deg = nearestChordTone(deg, tones);
        deg = intoRange(deg, H.low, H.high);
        notes.push({ ...n, step: n.step + 32, deg });
        prev = deg;
      }
      continue;
    }
    const onsets = hits(rhythm[b]);
    onsets.forEach(({ step }, i) => {
      const strong = step % 4 === 0 || i === 0;
      let deg;
      if (b === 3 && i === onsets.length - 1) {
        // land the phrase on something stable
        const target = rng.chance(0.6) ? 0 : chords[3].root;
        deg = intoRange(nearestChordTone(target, tones), H.low, H.high);
        if (Math.abs(deg - prev) > 4) deg = intoRange(nearestChordTone(prev, tones), H.low, H.high);
      } else {
        deg = pickNext(prev, tones, strong);
      }
      notes.push({ step: b * 16 + step, deg, strong, vel: round((strong ? 1 : 0.8) * rng.float(0.92, 1)) });
      prev = deg;
    });
  }

  if (density === 'sparse') {
    // drop most off-beat notes, but keep the phrase ending
    notes = notes.filter((n, i) => n.strong || i === notes.length - 1 || rng.chance(0.35));
  } else if (density === 'busy') {
    // fill long gaps with a passing note heading toward the next one
    const extra = [];
    notes.forEach((n, i) => {
      const next = notes[i + 1];
      const gap = (next ? next.step : 64) - n.step;
      if (gap >= 3 && Math.floor((n.step + 2) / 16) === Math.floor(n.step / 16) && rng.chance(0.7)) {
        const target = next ? next.deg : 0;
        const deg = clamp(n.deg + Math.sign(target - n.deg || 1), H.low, H.high);
        extra.push({ step: n.step + 2, deg, strong: false, vel: round(n.vel * 0.8) });
      }
    });
    notes = [...notes, ...extra].sort((a, z) => a.step - z.step);
  }

  notes.forEach((n, i) => {
    const next = i + 1 < notes.length ? notes[i + 1].step : 64;
    const endsPhrase = i + 1 === notes.length || Math.floor(next / 32) !== Math.floor(n.step / 32);
    n.dur = Math.min(next - n.step, endsPhrase ? H.maxLen * 2 : H.maxLen);
    // which slice of the word each chop uses (wrapped to however many exist)
    if (sliceMode === 'cycle') n.slice = i;
    else if (sliceMode === 'random') n.slice = rng.int(0, 7);
  });
  return notes;
}

export function generateSong({ mood = 'hype', seed = 1, voiceRoot = 60 } = {}) {
  return buildSong(rollRecipe(mood, seed), voiceRoot);
}

export function buildSong(recipe, voiceRoot = 60) {
  const mood = recipe.mood;
  const M = MOODS[mood];
  if (!M) throw new Error(`Unknown mood "${mood}"`);
  const groove = GROOVES[recipe.groove] ?? GROOVES[M.grooves[0]];
  const mode = SCALES[recipe.mode] ? recipe.mode : 'minor';
  const scale = SCALES[mode];
  const tonicPc = mod(recipe.tonic, 12);
  const flats = usesFlats(tonicPc, mode);
  const bpm = clamp(Math.round(recipe.bpm), 40, 220);
  const swing = clamp(recipe.swing ?? 0, 0, 0.5);
  const chop = recipe.chop;
  const melodyRng = createRng(recipe.melodySeed);
  const rng = createRng(recipe.detailSeed);

  // --- chords -------------------------------------------------------------
  let prevVoicing = null;
  const makeChord = (root) => {
    const s = chordQuality(scale, root) === 'dim' ? 3 : recipe.chordSize;
    const pcs = chordPcs(tonicPc, scale, root, s);
    // drop the 5th from 9th chords so the voicing doesn't get muddy
    const voicedPcs = s === 5 ? pcs.filter((_, i) => i !== 2) : pcs;
    const voicing = voiceChord(voicedPcs, prevVoicing, { low: 50, high: 74, center: 61 });
    prevVoicing = voicing;
    const rootPc = pcs[0];
    return {
      root,
      degrees: chordDegrees(root, s),
      symbol: chordSymbol(tonicPc, scale, root, s, flats),
      roman: romanNumeral(scale, root),
      voicing,
      bass: 33 + mod(rootPc - 33, 12),
      fifth: 33 + mod(rootPc + 7 - 33, 12),
    };
  };
  const chords = recipe.progression.slice(0, 4).map(makeChord);
  const homeChord = makeChord(0);

  const style = {
    groove: recipe.groove,
    grooveName: groove.name,
    kit: recipe.kit,
    pad: recipe.pad,
    pluck: recipe.pluck,
    keys: recipe.keys,
    bass: recipe.bass,
    texture: recipe.texture,
    pump: recipe.pump,
    padFilter: M.padFilter,
    chop,
  };
  const bassPattern = rng.pick(groove.bass);
  const keysPattern = KEYS_RHYTHMS[style.keys] ? rng.pick(KEYS_RHYTHMS[style.keys]) : null;
  const fill = rng.pick(FILLS);
  const hook = makeHook(melodyRng, M, chords, { density: chop.density, sliceMode: chop.mode });
  const sliceOf = (i) => (chop.mode === 'whole' ? undefined : i);

  // --- lay it out ---------------------------------------------------------
  const tracks = {
    pad: [],
    keys: [],
    bass: [],
    vox: [],
    voxRev: [],
    kick: [],
    snare: [],
    roll: [],
    hat: [],
    ohat: [],
    perc: [],
    crash: [],
  };
  const automation = [];
  const sections = [];
  const E = M.energy;
  const gate = chop.gate;
  const offset = chop.start;

  // which chord (index into song.chords) is playing in the bar at `step`
  const chordAt = (step) => {
    const bar = Math.floor(step / 16);
    const sec = sections.find((x) => bar >= x.startBar && bar < x.startBar + x.bars) ?? sections[sections.length - 1];
    if (!sec) return 0;
    const inSec = bar - sec.startBar;
    return sec.id === 'outro' && inSec === sec.bars - 1 ? 4 : inSec % 4;
  };

  const addSection = (id, name, n) => {
    const last = sections[sections.length - 1];
    const startBar = last ? last.startBar + last.bars : 0;
    const s = { id, name, startBar, bars: n, startStep: startBar * STEPS_PER_BAR, endStep: (startBar + n) * STEPS_PER_BAR };
    sections.push(s);
    return s;
  };

  const hookBar = (barInPhrase) => hook.filter((n) => Math.floor(n.step / 16) === barInPhrase);
  // `local` is the step inside the bar, n is a hook note (or a slice of one)
  const pushVox = (barStep, local, n, opts = {}) => {
    const vel = round(clamp(n.vel * (opts.vel ?? 1) * rng.float(0.94, 1.04), 0.05, 1));
    tracks.vox.push({
      chord: chordAt(barStep),
      step: barStep + local,
      dur: round(Math.max(0.5, n.dur * (opts.gate ?? gate))),
      deg: n.deg + (opts.shift ?? 0),
      vel,
      offset: opts.offset ?? offset,
      slice: n.slice,
    });
  };
  const pushGroove = (barStep, level = 1, parts = { kick: true, snare: true, hat: true, ohat: true, perc: true }, pump = 0) => {
    const push = (name, pattern, extra = {}) => {
      if (!pattern) return;
      for (const h of hits(pattern)) {
        const jitter = name === 'hat' ? rng.float(0.85, 1.05) : 1;
        tracks[name].push({ step: barStep + h.step, vel: round(clamp(h.vel * level * E * jitter, 0.02, 1)), ...extra });
      }
    };
    if (parts.kick) push('kick', groove.kick, { pump });
    if (parts.snare) push('snare', groove.snare);
    if (parts.hat) push('hat', groove.hat);
    if (parts.ohat) push('ohat', groove.ohat);
    if (parts.perc) push('perc', groove.perc);
  };
  const pushBassBar = (barStep, chord, index, vel = 1) => {
    const onsets = hits(bassPattern);
    onsets.forEach((h, i) => {
      const next = i + 1 < onsets.length ? onsets[i + 1].step : 16;
      const note = h.char === '5' ? chord.fifth : h.char === 'O' ? chord.bass + 12 : chord.bass;
      const v = h.char === 'R' ? 1 : 0.75;
      const dur = Math.max(1, Math.min(next - h.step, groove.bassMax) - 0.25);
      tracks.bass.push({ step: barStep + h.step, dur, note, vel: round(v * vel), chord: index });
    });
  };
  const pushKeysBar = (barStep, chord, index, vel) => {
    const v = chord.voicing;
    if (style.keys === 'arp8' || style.keys === 'arp16') {
      const every = style.keys === 'arp8' ? 2 : 1;
      const order = [...v, v[0] + 12, ...v.slice(1, -1).reverse()];
      for (let s = 0, i = 0; s < 16; s += every, i++) {
        const note = order[i % order.length] + 12;
        tracks.keys.push({ step: barStep + s, dur: every * 1.5, notes: [note], vel: round(vel * (s % 4 === 0 ? 1 : 0.75)), chord: index });
      }
    } else if (keysPattern) {
      const onsets = hits(keysPattern);
      onsets.forEach((h, i) => {
        const next = i + 1 < onsets.length ? onsets[i + 1].step : 16;
        const notes = v.slice(-3).map((n) => n + 12);
        tracks.keys.push({ step: barStep + h.step, dur: Math.min(next - h.step, 3) * 0.8, notes, vel: round(vel), chord: index });
      });
    }
  };
  // `index` points into song.chords (4 = the home chord at the very end)
  const pushPad = (at, dur, chord, index, vel) => {
    tracks.pad.push({ step: at, dur, notes: chord.voicing, vel: round(vel), chord: index });
  };

  // Intro: filtered chords, a teaser of the hook, maybe some hats.
  {
    const sec = addSection('intro', 'Intro', recipe.bars.intro);
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[0] * 1.3, to: M.padFilter[0] * 3, steps: sec.bars * 16 });
    for (let b = 0; b < sec.bars; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      pushPad(at, 16, chord, b % 4, b === 0 ? 0.6 : 0.72);
      if (M.introDrums === 'hats' && b >= sec.bars / 2) pushGroove(at, 0.45, { hat: true });
      if (M.introDrums === 'light' && b >= 1) pushGroove(at, 0.4, { hat: true, snare: b >= sec.bars / 2 });
      if (b % 2 === 1 && b >= sec.bars / 2) {
        for (const n of hookBar(1)) pushVox(at, n.step % 16, n, { vel: 0.55 });
      } else if (b === 1 || (sec.bars > 4 && b === 3)) {
        const deg = nearestChordTone(2, new Set(chord.degrees.map((d) => mod(d, 7))));
        tracks.vox.push({ step: at, dur: 8, deg, vel: 0.45, offset: 'start', slice: sliceOf(0), chord: b % 4 });
      }
    }
  }

  // Build: drums stack up, snare roll, riser, rising chops, then a breath.
  const writeBuild = (name, bars) => {
    const sec = addSection('build', name, bars);
    const n = sec.bars;
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[0] * 1.6, to: M.padFilter[1], steps: n * 16 });
    automation.push({ step: sec.startStep, type: 'riser', steps: n * 16 });
    // the last beat before the drop goes properly quiet
    automation.push({ step: sec.endStep - 4, type: 'gap', steps: 4 });
    const rollStart = n >= 8 ? n / 2 : 1;
    const fastRoll = E >= 0.95;
    for (let b = 0; b < n; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      const last = b === n - 1;
      const progress = b / n;
      pushPad(at, last ? 12 : 16, chord, b % 4, 0.55 + 0.3 * progress);
      // kick on every beat (not into the gap), held back so the drop hits harder
      for (let s = 0; s < (last ? 12 : 16); s += 4) {
        tracks.kick.push({ step: at + s, vel: round(E * (0.55 + 0.2 * progress)), pump: b >= n / 2 ? round(style.pump * 0.4, 2) : 0 });
      }
      if (b < n - 2 || n <= 4) {
        for (let s = 2; s < (last ? 12 : 16); s += 4) tracks.hat.push({ step: at + s, vel: round(0.45 * E) });
      }
      // snare roll
      const every = last ? 1 : b === n - 2 ? 2 : b >= rollStart ? 4 : 0;
      if (every) {
        for (let s = 0; s < (last ? 12 : 16); s += every) {
          const t = (b * 16 + s) / (n * 16);
          tracks.roll.push({ step: at + s, vel: round(clamp(0.25 + 0.75 * t, 0, 1) * E) });
          if (last && fastRoll && s >= 8) tracks.roll.push({ step: at + s + 0.5, vel: round(0.9 * E) });
        }
      }
      // chops
      if (!last) {
        const thin = b < n / 2;
        for (const note of hookBar(b % 2)) {
          if (thin && note.step % 2 === 1) continue;
          pushVox(at, note.step % 16, note, { vel: thin ? 0.7 : 0.85 });
        }
      } else {
        const every2 = fastRoll ? 1 : 2;
        for (let s = 0, i = 0; s < 12; s += every2, i++) {
          const deg = Math.floor(i / (every2 === 1 ? 2 : 1));
          tracks.vox.push({ step: at + s, dur: every2 * 0.8, deg, vel: round(0.5 + (0.5 * s) / 12), offset: 'start', slice: sliceOf(i), chord: b % 4 });
        }
      }
    }
  };

  // Drop: everything in, sidechain pump, the full hook. The second drop
  // starts straight on the variations (stutters, harmonies, octave jumps).
  const writeDrop = (name, bars, second = false) => {
    const sec = addSection('drop', name, bars);
    automation.push({ step: sec.startStep, type: 'impact' });
    automation.push({ step: sec.startStep, type: 'voxLift', on: true });
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[1], to: M.padFilter[1], steps: 1 });
    tracks.voxRev.push({ step: sec.startStep, deg: 0, vel: 0.8 });
    for (let b = 0; b < sec.bars; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      const phrase = Math.floor(b / 4);
      const barInPhrase = b % 4;
      if (b % 8 === 0) tracks.crash.push({ step: at, vel: b === 0 ? 1 : 0.7 });

      pushPad(at, 16, chord, b % 4, style.keys === 'sustain' ? 0.8 : 0.6);
      pushKeysBar(at, chord, b % 4, style.keys === 'sustain' ? 0 : second ? 0.8 : 0.7);
      pushBassBar(at, chord, b % 4, 1);

      pushGroove(at, 1, { kick: true, snare: true, hat: true, ohat: true, perc: true }, style.pump);
      if (barInPhrase === 3) {
        // drum fill over the last beat of each phrase
        hits(fill).forEach((h) => tracks.snare.push({ step: at + 12 + h.step, vel: round(h.vel * E) }));
      }
      if (groove.rolls && rng.chance(0.5)) {
        for (const s of [14, 14.5, 15, 15.5]) tracks.hat.push({ step: at + s, vel: round(rng.float(0.45, 0.7) * E) });
      }
      if (E >= 0.95 && b >= 8 && groove.hat[1] === '.') {
        for (let s = 1; s < 16; s += 2) tracks.hat.push({ step: at + s, vel: 0.22 });
      }

      for (const note of hookBar(barInPhrase)) {
        const variation = second ? phrase % 2 === 0 : phrase % 2 === 1;
        let shift = 0;
        if (variation && chop.octave && barInPhrase === 3 && note.deg + 7 <= M.hook.high) shift = 7;
        const local = note.step % 16;
        if (chop.stutter && note.dur >= 2 && rng.chance(0.3)) {
          const half = { ...note, dur: note.dur / 2 };
          pushVox(at, local, half, { shift });
          pushVox(at, local + half.dur, { ...half, vel: note.vel * 0.85 }, { shift });
        } else {
          pushVox(at, local, note, { shift });
        }
        if (variation && chop.harmony && note.dur >= 2) {
          const up = note.deg + shift + 2 <= M.hook.high;
          pushVox(at, local, note, { shift: shift + (up ? 2 : -2), vel: 0.5 });
        }
      }
    }
  };

  // Breakdown (two-drop songs): drums out, chords open up, the hook floats.
  const writeBreakdown = (bars) => {
    const sec = addSection('breakdown', 'Breakdown', bars);
    automation.push({ step: sec.startStep, type: 'voxLift', on: false });
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[1] * 0.3, to: M.padFilter[1] * 0.6, steps: bars * 16 });
    tracks.crash.push({ step: sec.startStep, vel: 0.5 });
    for (let b = 0; b < bars; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      const late = b >= bars / 2;
      pushPad(at, 16, chord, b % 4, 0.75);
      if (late) {
        pushKeysBar(at, chord, b % 4, style.keys === 'sustain' ? 0 : 0.45);
        pushGroove(at, 0.35, { hat: true });
      }
      if (b % 2 === 0) {
        for (const note of hookBar(b % 4)) pushVox(at, note.step % 16, note, { vel: 0.6, gate: Math.min(1, gate * 1.3) });
      } else {
        const deg = nearestChordTone(4, new Set(chord.degrees.map((d) => mod(d, 7))));
        tracks.vox.push({ step: at, dur: 12, deg, vel: 0.5, offset: 'start', slice: sliceOf(0), chord: b % 4 });
      }
    }
  };

  writeBuild('Build', recipe.bars.build);
  writeDrop('Drop', recipe.bars.drop);
  if (recipe.form === 'double') {
    writeBreakdown(recipe.bars.drop >= 16 ? 8 : 4);
    writeBuild('Build 2', 4);
    writeDrop('Drop 2', recipe.bars.drop, true);
  }

  // Outro: thin out, echo the hook, land on the home chord.
  {
    const sec = addSection('outro', 'Outro', recipe.bars.outro);
    const n = sec.bars;
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[1] * 0.6, to: M.padFilter[0], steps: n * 16 });
    automation.push({ step: sec.startStep, type: 'voxEcho' });
    automation.push({ step: sec.startStep, type: 'voxLift', on: false });
    for (let b = 0; b < n; b++) {
      const at = sec.startStep + b * 16;
      const last = b === n - 1;
      const chord = last ? homeChord : chords[b % 4];
      pushPad(at, last ? 28 : 16, chord, last ? 4 : b % 4, last ? 0.5 : 0.62);
      if (b < n / 2) {
        pushGroove(at, 0.7, { kick: true, snare: true, hat: true, ohat: false, perc: true });
        tracks.bass.push({ step: at, dur: 15.5, note: chord.bass, vel: 0.8, chord: b % 4 });
      } else if (!last) {
        pushGroove(at, 0.4, { hat: true });
      } else {
        tracks.crash.push({ step: at, vel: 0.45 });
        tracks.bass.push({ step: at, dur: 20, note: chord.bass, vel: 0.7, chord: 4 });
      }
      const hookBars = n >= 8 ? 4 : 2;
      if (b < hookBars) {
        for (const note of hookBar(b % 4)) pushVox(at, note.step % 16, note, { vel: 0.72 });
      } else if (b === n - 2) {
        tracks.vox.push({ step: at, dur: 8, deg: 4, vel: 0.6, offset: 'start', slice: sliceOf(0), chord: b % 4 });
      } else if (last) {
        tracks.vox.push({ step: at, dur: 12, deg: 0, vel: 0.55, offset: 'start', slice: sliceOf(0), chord: 4 });
      }
    }
  }

  const totalBars = sections.reduce((sum, s) => sum + s.bars, 0);
  const totalSteps = totalBars * STEPS_PER_BAR;
  const stepSec = 60 / bpm / 4;

  for (const list of Object.values(tracks)) list.sort((a, b) => a.step - b.step);
  // A drum can only be hit once per instant: merge doubled hits (fills
  // landing on a groove hit, rolls on top of hats), keeping the louder one.
  for (const name of ['kick', 'snare', 'roll', 'hat', 'ohat', 'perc', 'crash', 'bass']) {
    tracks[name] = tracks[name].filter((e, i, list) => {
      const next = list[i + 1];
      if (next && next.step === e.step) {
        next.vel = Math.max(next.vel, e.vel);
        if (e.pump) next.pump = Math.max(next.pump ?? 0, e.pump);
        return false;
      }
      return true;
    });
  }

  const song = {
    mood,
    seed: recipe.seed,
    recipe,
    bpm,
    swing,
    mode,
    tonicPc,
    flats,
    key: keyName(tonicPc, mode),
    chords: [...chords, homeChord].map(({ root, symbol, roman, voicing, bass }) => ({ root, symbol, roman, voicing, bass })),
    progression: chords.map((c) => c.roman).join('–'),
    sections,
    totalBars,
    totalSteps,
    stepSec,
    durationSec: totalSteps * stepSec,
    style,
    fx: recipe.fx,
    hook,
    tracks,
    automation,
  };
  return applyVoice(song, voiceRoot);
}

// Map melody scale degrees onto MIDI notes for a given voice pitch. Cheap,
// so recording a new word just re-runs this instead of a new song.
export function applyVoice(song, voiceRoot) {
  const scale = SCALES[song.mode];
  const shift = song.style.chop?.shift ?? 0;
  const melodyTonic = melodyTonicFor(song.tonicPc, voiceRoot, MOODS[song.mood].melodyLift) + shift;
  const midiOf = (deg) => degreeToMidi(melodyTonic, scale, deg);
  return {
    ...song,
    voiceRoot,
    melodyTonic,
    tracks: {
      ...song.tracks,
      vox: song.tracks.vox.map((e) => ({ ...e, midi: midiOf(e.deg) })),
      voxRev: song.tracks.voxRev.map((e) => ({ ...e, midi: midiOf(e.deg) })),
    },
  };
}

export function sectionAt(song, step) {
  return song.sections.find((s) => step >= s.startStep && step < s.endStep) ?? null;
}

// Song codes: a recipe squeezed into a string people can copy around.
export function encodeRecipe(recipe) {
  const bytes = new TextEncoder().encode(JSON.stringify(recipe));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeRecipe(code) {
  try {
    const b64 = String(code).trim().replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const recipe = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return validRecipe(recipe) ? recipe : null;
  } catch {
    return null;
  }
}

export function validRecipe(r) {
  return Boolean(
    r &&
      MOODS[r.mood] &&
      SCALES[r.mode] &&
      Number.isInteger(r.tonic) &&
      Array.isArray(r.progression) &&
      r.progression.length === 4 &&
      r.progression.every((d) => Number.isInteger(d) && d >= 0 && d < 7) &&
      [3, 4, 5].includes(r.chordSize) &&
      GROOVES[r.groove] &&
      Number.isFinite(r.bpm) &&
      r.chop &&
      r.bars &&
      ['intro', 'build', 'drop', 'outro'].every((k) => Number.isInteger(r.bars[k]) && r.bars[k] >= 4 && r.bars[k] <= 32 && r.bars[k] % 4 === 0) &&
      r.fx &&
      (r.form === undefined || r.form === 'single' || r.form === 'double') &&
      Number.isFinite(r.melodySeed) &&
      Number.isFinite(r.detailSeed),
  );
}
