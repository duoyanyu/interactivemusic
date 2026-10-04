// Turns (mood, seed, voice pitch) into a full arrangement: chords, drums,
// bass, keys and a vocal-chop melody laid out over intro / build / drop /
// outro. Pure data, no audio, so it can be tested and drawn before any
// sound plays. Same seed + mood = same song.

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

export const STEPS_PER_BAR = 16;
export const TAIL_SECONDS = 3.5;

// Drum grooves, one bar of 16th notes. Digits are velocity (9 = full).
// Bass letters: R root, r soft root, 5 fifth, O octave up.
export const GROOVES = {
  four: {
    name: 'four on the floor',
    bpm: [122, 128],
    swing: [0, 0.03],
    kick: '9...9...9...9...',
    snare: '....9.......9...',
    hat: '.3.3.3.3.3.3.3.3',
    ohat: '..7...7...7...7.',
    snareSound: 'clap',
    bass: ['..R...R...R...R.', '..R..rR...R..rR.', '..R...R.O.R...R.'],
    bassMax: 2,
    rolls: false,
  },
  halftime: {
    name: 'half-time',
    bpm: [140, 150],
    swing: [0, 0.03],
    kick: '9.........7.....',
    snare: '........9.......',
    hat: '7.4.6.4.7.4.6.4.',
    ohat: '................',
    snareSound: 'clap',
    bass: ['R.........R.....', 'R.....r...R..5..'],
    bassMax: 10,
    rolls: true,
  },
  breaks: {
    name: 'breakbeat',
    bpm: [126, 134],
    swing: [0, 0.05],
    kick: '9.....7...9.....',
    snare: '....9.......9..4',
    hat: '7.4.7.4.7.4.7.4.',
    ohat: '..............6.',
    snareSound: 'snare',
    bass: ['R..R..R...R..5..', 'R.....R...R.r...'],
    bassMax: 3,
    rolls: false,
  },
  ballad: {
    name: 'slow ballad',
    bpm: [72, 84],
    swing: [0, 0.06],
    kick: '9.......7.5.....',
    snare: '....7.......7...',
    hat: '5.3.5.3.5.3.5.3.',
    ohat: '................',
    snareSound: 'snare',
    bass: ['R...............', 'R.......5.......'],
    bassMax: 16,
    rolls: false,
  },
  slowburn: {
    name: 'half-time ballad',
    bpm: [68, 78],
    swing: [0.04, 0.1],
    kick: '9......5..7.....',
    snare: '........8.......',
    hat: '4.3.4.3.4.3.4.3.',
    ohat: '..............4.',
    snareSound: 'clap',
    bass: ['R.........5.....', 'R.......r.......'],
    bassMax: 10,
    rolls: true,
  },
  lofi: {
    name: 'lo-fi shuffle',
    bpm: [80, 90],
    swing: [0.18, 0.3],
    kick: '9......5..9.....',
    snare: '....7.......7...',
    hat: '5.3.5.3.5.3.5.3.',
    ohat: '................',
    snareSound: 'rim',
    bass: ['R.....5...R.....', 'R.....R...5.....'],
    bassMax: 6,
    rolls: false,
  },
  chill: {
    name: 'chill bounce',
    bpm: [92, 102],
    swing: [0.08, 0.16],
    kick: '9...5.....9.....',
    snare: '....8.......8...',
    hat: '3.6.3.6.3.6.3.6.',
    ohat: '..............5.',
    snareSound: 'clap',
    bass: ['R..R....5..R....', 'R.....5...R..r..'],
    bassMax: 4,
    rolls: false,
  },
};

// Rhythms for the vocal hook. "x" = a chop. First list opens a 2-bar
// phrase, second list answers it and leaves room to breathe.
const HOOK_RHYTHMS = {
  sad: {
    call: ['x...x..x....x...', 'x.....x.x...x...', 'x..x....x.x.....', '..x.x...x...x...'],
    answer: ['x...x...x.......', 'x..x..x.........', 'x.....x.........'],
  },
  hype: {
    call: ['x..x..x.x.x..x..', 'x.x..x.xx..x.x..', 'x..x..x...x.x.x.', '..x..x..x.x..x..', 'x.xx..x.x..x..x.'],
    answer: ['x..x..x.x.......', 'x.x..x.x........', 'x..x..x...x.....'],
  },
  dreamy: {
    call: ['x...x.x...x.x...', '..x...x...x.x..x', 'x..x..x...x..x..', 'x.x...x.x...x...'],
    answer: ['x...x.x.........', 'x..x..x.........', '..x...x...x.....'],
  },
};

const KEYS_RHYTHMS = {
  stabs: ['x..x..x...x.x...', 'x..x..x.x..x.x..', '..x..x..x..x..x.'],
  pulse: ['..x...x...x...x.'],
};

const FILLS = ['.5.7', '5577', '3579', '..79', '7.77'];

export const MOODS = {
  sad: {
    label: 'Sad',
    modes: ['minor'],
    progressions: {
      minor: [
        [0, 5, 2, 6],
        [0, 3, 5, 4],
        [5, 6, 0, 0],
        [0, 6, 5, 6],
        [0, 3, 6, 2],
        [5, 3, 0, 4],
        [0, 5, 3, 4],
      ],
    },
    seventhChance: 0.5,
    ninthChance: 0.1,
    grooves: ['ballad', 'slowburn'],
    pads: ['warm', 'felt'],
    plucks: ['pluck', 'bell'],
    basses: ['sub'],
    keysStyles: ['sustain', 'arp8'],
    bars: { intro: [4], build: [4], drop: [8], outro: [4] },
    introDrums: 'none',
    pump: [0.12, 0.25],
    melodyLift: 0,
    hook: { maxLen: 6, gate: [0.8, 1], low: -2, high: 7 },
    energy: 0.75,
    padFilter: [550, 2400],
    fx: { reverb: [55, 75], size: [55, 85], delay: [30, 50], feedback: [35, 55] },
    chop: { stutter: 0.05, harmony: 0.3, octave: 0.2, vowel: 0.5 },
  },
  hype: {
    label: 'Hype',
    modes: ['minor'],
    progressions: {
      minor: [
        [0, 5, 2, 6],
        [0, 5, 6, 0],
        [5, 6, 0, 0],
        [0, 3, 5, 6],
        [0, 6, 5, 6],
        [0, 5, 3, 6],
      ],
    },
    seventhChance: 0.25,
    ninthChance: 0,
    grooves: ['four', 'halftime', 'breaks'],
    pads: ['supersaw', 'warm'],
    plucks: ['stab'],
    basses: ['saw'],
    keysStyles: ['stabs', 'pulse', 'sustain'],
    bars: { intro: [4, 8], build: [8], drop: [16], outro: [4, 8] },
    introDrums: 'hats',
    pump: [0.55, 0.8],
    melodyLift: 5,
    hook: { maxLen: 3, gate: [0.55, 0.85], low: -2, high: 7 },
    energy: 1,
    padFilter: [700, 9000],
    fx: { reverb: [30, 50], size: [35, 60], delay: [25, 45], feedback: [25, 45] },
    chop: { stutter: 0.35, harmony: 0.4, octave: 0.45, vowel: 0.4 },
  },
  dreamy: {
    label: 'Dreamy',
    modes: ['major', 'major', 'lydian'],
    progressions: {
      major: [
        [3, 4, 2, 5],
        [0, 3, 5, 4],
        [0, 5, 3, 4],
        [3, 0, 4, 5],
        [5, 3, 0, 4],
        [0, 2, 3, 3],
      ],
      lydian: [
        [0, 1, 0, 1],
        [0, 1, 5, 4],
        [5, 1, 0, 0],
      ],
    },
    seventhChance: 0.85,
    ninthChance: 0.4,
    grooves: ['lofi', 'chill'],
    pads: ['glass', 'choir'],
    plucks: ['bell', 'pluck'],
    basses: ['round'],
    keysStyles: ['arp16', 'arp8', 'stabs'],
    bars: { intro: [4], build: [4], drop: [8, 12], outro: [4] },
    introDrums: 'light',
    pump: [0.2, 0.4],
    melodyLift: 3,
    hook: { maxLen: 4, gate: [0.7, 0.95], low: -2, high: 8 },
    energy: 0.8,
    padFilter: [900, 4200],
    fx: { reverb: [60, 85], size: [60, 90], delay: [40, 60], feedback: [40, 60] },
    chop: { stutter: 0.1, harmony: 0.5, octave: 0.3, vowel: 0.6 },
  },
};

export const MOOD_IDS = Object.keys(MOODS);

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

function makeHook(rng, mood, chords) {
  const H = MOODS[mood].hook;
  const R = HOOK_RHYTHMS[mood];
  const call = rng.pick(R.call);
  const answer = rng.pick(R.answer);
  const lastAnswer = rng.chance(0.5) ? rng.pick(R.answer) : answer;
  const rhythm = [call, answer, call, lastAnswer];
  const center = rng.pick([1, 2, 3]);
  const tonesOf = (chord) => new Set(chord.degrees.map((d) => mod(d, 7)));

  const notes = [];
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

  notes.forEach((n, i) => {
    const next = i + 1 < notes.length ? notes[i + 1].step : 64;
    const endsPhrase = i + 1 === notes.length || Math.floor(next / 32) !== Math.floor(n.step / 32);
    n.dur = Math.min(next - n.step, endsPhrase ? H.maxLen * 2 : H.maxLen);
  });
  return notes;
}

export function generateSong({ mood = 'hype', seed = 1, voiceRoot = 60 } = {}) {
  const M = MOODS[mood];
  if (!M) throw new Error(`Unknown mood "${mood}"`);
  const rng = createRng(seed);

  // --- key, tempo, groove -------------------------------------------------
  const mode = rng.pick(M.modes);
  const scale = SCALES[mode];
  const tonicPc = rng.int(0, 11);
  const flats = usesFlats(tonicPc, mode);
  const grooveId = rng.pick(M.grooves);
  const groove = GROOVES[grooveId];
  const bpm = rng.int(groove.bpm[0], groove.bpm[1]);
  const swing = round(rng.float(groove.swing[0], groove.swing[1]));

  // --- chords -------------------------------------------------------------
  const roots = rng.pick(M.progressions[mode]);
  const size = rng.chance(M.ninthChance) ? 5 : rng.chance(M.seventhChance) ? 4 : 3;
  let prevVoicing = null;
  const makeChord = (root) => {
    const s = chordQuality(scale, root) === 'dim' ? 3 : size;
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
  const chords = roots.map(makeChord);
  const homeChord = makeChord(0);

  // --- sound + arrangement choices ---------------------------------------
  const bars = {
    intro: rng.pick(M.bars.intro),
    build: rng.pick(M.bars.build),
    drop: rng.pick(M.bars.drop),
    outro: rng.pick(M.bars.outro),
  };
  const style = {
    groove: grooveId,
    grooveName: groove.name,
    snareSound: groove.snareSound,
    pad: rng.pick(M.pads),
    pluck: rng.pick(M.plucks),
    bass: grooveId === 'halftime' ? '808' : rng.pick(M.basses),
    keys: rng.pick(M.keysStyles),
    pump: round(rng.float(M.pump[0], M.pump[1]), 2),
    padFilter: M.padFilter,
    chop: {
      gate: round(rng.float(M.hook.gate[0], M.hook.gate[1]), 2),
      offset: rng.chance(M.chop.vowel) ? 'vowel' : 'start',
      stutter: rng.chance(M.chop.stutter * 2),
      harmony: rng.chance(M.chop.harmony),
      octave: rng.chance(M.chop.octave),
    },
  };
  const bassPattern = rng.pick(groove.bass);
  const keysPattern = KEYS_RHYTHMS[style.keys] ? rng.pick(KEYS_RHYTHMS[style.keys]) : null;
  const fill = rng.pick(FILLS);
  const fx = {
    reverb: rng.int(M.fx.reverb[0], M.fx.reverb[1]),
    size: rng.int(M.fx.size[0], M.fx.size[1]),
    delay: rng.int(M.fx.delay[0], M.fx.delay[1]),
    feedback: rng.int(M.fx.feedback[0], M.fx.feedback[1]),
  };
  const hook = makeHook(rng, mood, chords);

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
    crash: [],
  };
  const automation = [];
  const sections = [];
  const E = M.energy;
  const gate = style.chop.gate;
  const offset = style.chop.offset;

  const addSection = (id, name, n) => {
    const startBar = sections.length ? sections[sections.length - 1].startBar + sections[sections.length - 1].bars : 0;
    const s = { id, name, startBar, bars: n, startStep: startBar * STEPS_PER_BAR, endStep: (startBar + n) * STEPS_PER_BAR };
    sections.push(s);
    return s;
  };

  const hookBar = (barInPhrase) => hook.filter((n) => Math.floor(n.step / 16) === barInPhrase);
  // `local` is the step inside the bar, n is a hook note (or a slice of one)
  const pushVox = (barStep, local, n, opts = {}) => {
    const vel = round(clamp(n.vel * (opts.vel ?? 1) * rng.float(0.94, 1.04), 0.05, 1));
    tracks.vox.push({
      step: barStep + local,
      dur: round(Math.max(0.5, n.dur * (opts.gate ?? gate))),
      deg: n.deg + (opts.shift ?? 0),
      vel,
      offset: opts.offset ?? offset,
    });
  };
  const pushGroove = (barStep, scale_ = 1, parts = { kick: true, snare: true, hat: true, ohat: true }, pump = 0) => {
    if (parts.kick) for (const h of hits(groove.kick)) tracks.kick.push({ step: barStep + h.step, vel: round(h.vel * scale_ * E), pump });
    if (parts.snare) for (const h of hits(groove.snare)) tracks.snare.push({ step: barStep + h.step, vel: round(h.vel * scale_ * E) });
    if (parts.hat) for (const h of hits(groove.hat)) tracks.hat.push({ step: barStep + h.step, vel: round(h.vel * scale_ * E * rng.float(0.85, 1.05)) });
    if (parts.ohat) for (const h of hits(groove.ohat)) tracks.ohat.push({ step: barStep + h.step, vel: round(h.vel * scale_ * E) });
  };
  const pushBassBar = (barStep, chord, vel = 1) => {
    const onsets = hits(bassPattern);
    onsets.forEach((h, i) => {
      const next = i + 1 < onsets.length ? onsets[i + 1].step : 16;
      const note = h.char === '5' ? chord.fifth : h.char === 'O' ? chord.bass + 12 : chord.bass;
      const v = h.char === 'R' ? 1 : 0.75;
      tracks.bass.push({ step: barStep + h.step, dur: Math.max(1, Math.min(next - h.step, groove.bassMax) - 0.25), note, vel: round(v * vel) });
    });
  };
  const pushKeysBar = (barStep, chord, vel) => {
    const v = chord.voicing;
    if (style.keys === 'arp8' || style.keys === 'arp16') {
      const every = style.keys === 'arp8' ? 2 : 1;
      const order = [...v, v[0] + 12, ...v.slice(1, -1).reverse()];
      for (let s = 0, i = 0; s < 16; s += every, i++) {
        tracks.keys.push({ step: barStep + s, dur: every * 1.5, notes: [order[i % order.length] + 12], vel: round(vel * (s % 4 === 0 ? 1 : 0.75)) });
      }
    } else if (keysPattern) {
      const onsets = hits(keysPattern);
      onsets.forEach((h, i) => {
        const next = i + 1 < onsets.length ? onsets[i + 1].step : 16;
        tracks.keys.push({ step: barStep + h.step, dur: Math.min(next - h.step, 3) * 0.8, notes: v.slice(-3).map((n) => n + 12), vel: round(vel) });
      });
    }
  };

  // Intro: filtered chords, a teaser of the hook, maybe some hats.
  {
    const sec = addSection('intro', 'Intro', bars.intro);
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[0] * 1.3, to: M.padFilter[0] * 3, steps: sec.bars * 16 });
    for (let b = 0; b < sec.bars; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      tracks.pad.push({ step: at, dur: 16, notes: chord.voicing, vel: b === 0 ? 0.6 : 0.72 });
      if (M.introDrums === 'hats' && b >= sec.bars / 2) pushGroove(at, 0.45, { hat: true });
      if (M.introDrums === 'light' && b >= 1) pushGroove(at, 0.4, { hat: true, snare: b >= sec.bars / 2 });
      if (b % 2 === 1 && b >= sec.bars / 2) {
        for (const n of hookBar(1)) pushVox(at, n.step % 16, n, { vel: 0.55 });
      } else if (b === 1 || (sec.bars > 4 && b === 3)) {
        tracks.vox.push({ step: at, dur: 8, deg: nearestChordTone(2, new Set(chord.degrees.map((d) => mod(d, 7)))), vel: 0.45, offset: 'start' });
      }
    }
  }

  // Build: drums stack up, snare roll, riser, rising chops, then a breath.
  {
    const sec = addSection('build', 'Build', bars.build);
    const n = sec.bars;
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[0] * 1.6, to: M.padFilter[1], steps: n * 16 });
    automation.push({ step: sec.startStep, type: 'riser', steps: n * 16 });
    const rollStart = n >= 8 ? n / 2 : 1;
    for (let b = 0; b < n; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      const last = b === n - 1;
      const progress = b / n;
      tracks.pad.push({ step: at, dur: last ? 12 : 16, notes: chord.voicing, vel: round(0.55 + 0.3 * progress) });
      // kick on every beat (not into the gap)
      for (let s = 0; s < (last ? 12 : 16); s += 4) {
        tracks.kick.push({ step: at + s, vel: round(E * (0.75 + 0.2 * progress)), pump: b >= n / 2 ? round(style.pump * 0.5, 2) : 0 });
      }
      if (b < n - 2 || n <= 4) {
        for (let s = 2; s < (last ? 12 : 16); s += 4) tracks.hat.push({ step: at + s, vel: round(0.45 * E) });
      }
      if (b >= n / 2) {
        for (let s = 0; s < (last ? 12 : 16); s += 8) tracks.bass.push({ step: at + s, dur: last ? 3.5 : 7.5, note: chord.bass, vel: 0.8 });
      }
      // snare roll
      const every = last ? 1 : b === n - 2 ? 2 : b >= rollStart ? 4 : 0;
      if (every) {
        for (let s = 0; s < (last ? 12 : 16); s += every) {
          const t = (b * 16 + s) / (n * 16);
          tracks.roll.push({ step: at + s, vel: round(clamp(0.25 + 0.75 * t, 0, 1) * E) });
          if (last && mood === 'hype' && s >= 8) tracks.roll.push({ step: at + s + 0.5, vel: round(0.9 * E) });
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
        const every2 = mood === 'hype' ? 1 : 2;
        for (let s = 0, i = 0; s < 12; s += every2, i++) {
          const deg = Math.floor(i / (every2 === 1 ? 2 : 1));
          tracks.vox.push({ step: at + s, dur: every2 * 0.8, deg, vel: round(0.5 + (0.5 * s) / 12), offset: 'start' });
        }
      }
    }
  }

  // Drop: everything in, sidechain pump, the full hook.
  {
    const sec = addSection('drop', 'Drop', bars.drop);
    automation.push({ step: sec.startStep, type: 'impact' });
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[1], to: M.padFilter[1], steps: 1 });
    tracks.voxRev.push({ step: sec.startStep, deg: 0, vel: 0.8 });
    for (let b = 0; b < sec.bars; b++) {
      const at = sec.startStep + b * 16;
      const chord = chords[b % 4];
      const phrase = Math.floor(b / 4);
      const barInPhrase = b % 4;
      if (b === 0 || (b === 8 && sec.bars >= 16)) tracks.crash.push({ step: at, vel: b === 0 ? 1 : 0.7 });

      tracks.pad.push({ step: at, dur: 16, notes: chord.voicing, vel: style.keys === 'sustain' ? 0.8 : 0.6 });
      pushKeysBar(at, chord, style.keys === 'sustain' ? 0 : 0.7);
      pushBassBar(at, chord, 1);

      pushGroove(at, 1, { kick: true, snare: true, hat: true, ohat: true }, style.pump);
      if (barInPhrase === 3) {
        // drum fill over the last beat of each phrase
        hits(fill).forEach((h) => tracks.snare.push({ step: at + 12 + h.step, vel: round(h.vel * E) }));
      }
      if (groove.rolls && rng.chance(0.5)) {
        for (const s of [14, 14.5, 15, 15.5]) tracks.hat.push({ step: at + s, vel: round(rng.float(0.45, 0.7) * E) });
      }
      if (mood === 'hype' && b >= 8 && groove.hat[1] === '.') {
        for (let s = 1; s < 16; s += 2) tracks.hat.push({ step: at + s, vel: 0.22 });
      }

      for (const note of hookBar(barInPhrase)) {
        const variation = phrase % 2 === 1;
        let shift = 0;
        if (variation && style.chop.octave && barInPhrase === 3 && note.deg + 7 <= MOODS[mood].hook.high) shift = 7;
        const local = note.step % 16;
        if (style.chop.stutter && note.dur >= 2 && rng.chance(0.3)) {
          const half = { ...note, dur: note.dur / 2 };
          pushVox(at, local, half, { shift });
          pushVox(at, local + half.dur, { ...half, vel: note.vel * 0.85 }, { shift });
        } else {
          pushVox(at, local, note, { shift });
        }
        if (variation && style.chop.harmony && note.dur >= 2) {
          const up = note.deg + shift + 2 <= MOODS[mood].hook.high;
          pushVox(at, local, note, { shift: shift + (up ? 2 : -2), vel: 0.5 });
        }
      }
    }
  }

  // Outro: thin out, echo the hook, land on the home chord.
  {
    const sec = addSection('outro', 'Outro', bars.outro);
    const n = sec.bars;
    automation.push({ step: sec.startStep, type: 'padFilter', from: M.padFilter[1] * 0.6, to: M.padFilter[0], steps: n * 16 });
    automation.push({ step: sec.startStep, type: 'voxEcho' });
    for (let b = 0; b < n; b++) {
      const at = sec.startStep + b * 16;
      const last = b === n - 1;
      const chord = last ? homeChord : chords[b % 4];
      tracks.pad.push({ step: at, dur: last ? 28 : 16, notes: chord.voicing, vel: round(last ? 0.5 : 0.62) });
      if (b < n / 2) {
        pushGroove(at, 0.7, { kick: true, snare: true, hat: true, ohat: false });
        tracks.bass.push({ step: at, dur: 15.5, note: chord.bass, vel: 0.8 });
      } else if (!last) {
        pushGroove(at, 0.4, { hat: true });
      } else {
        tracks.crash.push({ step: at, vel: 0.45 });
        tracks.bass.push({ step: at, dur: 20, note: chord.bass, vel: 0.7 });
      }
      const hookBars = n >= 8 ? 4 : 2;
      if (b < hookBars) {
        for (const note of hookBar(b % 4)) pushVox(at, note.step % 16, note, { vel: 0.72 });
      } else if (b === n - 2) {
        tracks.vox.push({ step: at, dur: 8, deg: 4, vel: 0.6, offset: 'start' });
      } else if (last) {
        tracks.vox.push({ step: at, dur: 12, deg: 0, vel: 0.55, offset: 'start' });
      }
    }
  }

  const totalBars = sections.reduce((sum, s) => sum + s.bars, 0);
  const totalSteps = totalBars * STEPS_PER_BAR;
  const stepSec = 60 / bpm / 4;

  for (const list of Object.values(tracks)) list.sort((a, b) => a.step - b.step);
  // A drum can only be hit once per instant: merge doubled hits (fills
  // landing on a groove hit, rolls on top of hats), keeping the louder one.
  for (const name of ['kick', 'snare', 'roll', 'hat', 'ohat', 'crash', 'bass']) {
    tracks[name] = tracks[name].filter((e, i, list) => {
      const next = list[i + 1];
      if (next && next.step === e.step) {
        next.vel = Math.max(next.vel, e.vel);
        return false;
      }
      return true;
    });
  }

  const song = {
    mood,
    seed,
    bpm,
    swing,
    mode,
    tonicPc,
    flats,
    key: keyName(tonicPc, mode),
    chords: chords.map(({ symbol, roman, voicing, bass }) => ({ symbol, roman, voicing, bass })),
    progression: chords.map((c) => c.roman).join('–'),
    sections,
    totalBars,
    totalSteps,
    stepSec,
    durationSec: totalSteps * stepSec,
    style,
    fx,
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
  const melodyTonic = melodyTonicFor(song.tonicPc, voiceRoot, MOODS[song.mood].melodyLift);
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
