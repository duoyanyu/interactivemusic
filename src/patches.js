// Sound design: synth patches, drum kits and background textures, as plain
// Tone.js option objects. engine.js builds instruments from these; moods.js
// and the studio panel refer to them by id.

/**
 * Pad: { label, oscillator, envelope, volume (dB), chorus (0-1 wet) }.
 * Played by a Tone.PolySynth(Tone.Synth) through a lowpass that the
 * arrangement sweeps, so keep the raw sound fairly bright.
 */
export const PAD_PATCHES = {
  supersaw: {
    label: 'Supersaw',
    oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
    envelope: { attack: 0.03, decay: 0.3, sustain: 0.8, release: 0.9 },
    volume: -13,
    chorus: 0,
  },
  warm: {
    label: 'Warm saw',
    oscillator: { type: 'fatsawtooth', count: 2, spread: 14 },
    envelope: { attack: 0.5, decay: 1, sustain: 0.8, release: 2.2 },
    volume: -10,
    chorus: 0.4,
  },
  felt: {
    label: 'Felt',
    oscillator: { type: 'fattriangle', count: 3, spread: 18 },
    envelope: { attack: 0.25, decay: 1.2, sustain: 0.6, release: 2 },
    volume: -6,
    chorus: 0.5,
  },
  glass: {
    label: 'Glass',
    oscillator: { type: 'fatsine', count: 3, spread: 24 },
    envelope: { attack: 0.4, decay: 1, sustain: 0.7, release: 2.5 },
    volume: -5,
    chorus: 0.6,
  },
  choir: {
    label: 'Hollow choir',
    oscillator: { type: 'fatsquare', count: 3, spread: 25 },
    envelope: { attack: 0.6, decay: 1, sustain: 0.8, release: 2.5 },
    volume: -15,
    chorus: 0.6,
  },
  stringmachine: {
    label: 'String machine',
    oscillator: { type: 'fatsawtooth', count: 3, spread: 36 },
    envelope: { attack: 0.12, decay: 0.6, sustain: 0.85, release: 1.2 },
    volume: -12,
    chorus: 0.55,
  },
  haunt: {
    label: 'Haunted',
    // wide detune on two squares beats slowly against itself
    oscillator: { type: 'fatsquare', count: 2, spread: 48 },
    envelope: { attack: 0.8, decay: 1.5, sustain: 0.75, release: 3 },
    volume: -14,
    chorus: 0.3,
  },
  haze: {
    label: 'Haze',
    oscillator: { type: 'fatsine', count: 2, spread: 12 },
    envelope: { attack: 0.35, decay: 1.4, sustain: 0.6, release: 2 },
    volume: -5,
    chorus: 0.8,
  },
  brass: {
    label: 'Poly brass',
    oscillator: { type: 'fatsawtooth', count: 3, spread: 12 },
    envelope: { attack: 0.06, decay: 0.5, sustain: 0.75, release: 0.7 },
    volume: -12,
    chorus: 0.35,
  },
  strings: {
    label: 'Strings',
    oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
    envelope: { attack: 1.1, decay: 2, sustain: 0.9, release: 3 },
    volume: -12,
    chorus: 0.45,
  },
};

/**
 * Keys / pluck: { label, voice: 'Synth' | 'FMSynth' | 'AMSynth' | 'MonoSynth',
 * options (constructor options for that voice), volume (dB), cutoff (Hz) }.
 * Played by a Tone.PolySynth of that voice for arps, stabs and pulses.
 */
export const PLUCK_PATCHES = {
  stab: {
    label: 'Saw stab',
    voice: 'Synth',
    options: {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 20 },
      envelope: { attack: 0.002, decay: 0.2, sustain: 0.15, release: 0.12 },
    },
    volume: -5,
    cutoff: 5200,
  },
  pluck: {
    label: 'Soft pluck',
    voice: 'Synth',
    options: {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.3 },
    },
    volume: -4,
    cutoff: 3200,
  },
  bell: {
    label: 'FM bell',
    voice: 'FMSynth',
    options: {
      harmonicity: 3,
      modulationIndex: 5,
      envelope: { attack: 0.002, decay: 0.8, sustain: 0, release: 0.8 },
      modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.3 },
    },
    volume: -7,
    cutoff: 6000,
  },
  marimba: {
    label: 'Marimba',
    voice: 'FMSynth',
    // a 4:1 modulator that dies almost at once gives the mallet knock
    options: {
      harmonicity: 4,
      modulationIndex: 2.5,
      modulation: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.35 },
      modulationEnvelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.1 },
    },
    volume: -5,
    cutoff: 5000,
  },
  piano: {
    label: 'Bright keys',
    voice: 'FMSynth',
    options: {
      harmonicity: 2,
      modulationIndex: 3.5,
      modulation: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1, sustain: 0.05, release: 0.6 },
      modulationEnvelope: { attack: 0.002, decay: 0.3, sustain: 0.1, release: 0.4 },
    },
    volume: -8,
    cutoff: 5500,
  },
  rhodes: {
    label: 'Rhodes',
    voice: 'FMSynth',
    options: {
      harmonicity: 1,
      modulationIndex: 2.2,
      modulation: { type: 'sine' },
      envelope: { attack: 0.003, decay: 1.6, sustain: 0.25, release: 1 },
      modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0.2, release: 0.8 },
    },
    volume: -9,
    cutoff: 2600,
  },
  eerie: {
    label: 'Eerie bell',
    voice: 'FMSynth',
    // non-integer ratio = inharmonic, slightly out-of-tune overtones
    options: {
      harmonicity: 1.41,
      modulationIndex: 4,
      modulation: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1.2, sustain: 0, release: 1 },
      modulationEnvelope: { attack: 0.002, decay: 0.6, sustain: 0.1, release: 0.6 },
    },
    volume: -9,
    cutoff: 3500,
  },
  arp: {
    label: 'Saw arp',
    voice: 'Synth',
    options: {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.002, decay: 0.16, sustain: 0.2, release: 0.1 },
    },
    volume: -11,
    cutoff: 3800,
  },
  brass: {
    label: 'Brass stab',
    voice: 'Synth',
    options: {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 14 },
      envelope: { attack: 0.03, decay: 0.35, sustain: 0.45, release: 0.25 },
    },
    volume: -12,
    cutoff: 3000,
  },
};

/**
 * Bass: { label, voice: 'MonoSynth' | 'MembraneSynth' | 'Synth' | 'FMSynth',
 * options, volume (dB), drive (0-1, optional distortion) }.
 * Notes sit around MIDI 33-44 (A1-G#2).
 */
export const BASS_PATCHES = {
  saw: {
    label: 'Saw bass',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'sawtooth' },
      filter: { Q: 2, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.004, decay: 0.2, sustain: 0.7, release: 0.06 },
      filterEnvelope: { attack: 0.002, decay: 0.18, sustain: 0.25, release: 0.1, baseFrequency: 90, octaves: 3.2 },
    },
    volume: -13,
  },
  808: {
    label: '808',
    voice: 'MembraneSynth',
    options: {
      pitchDecay: 0.06,
      octaves: 1.8,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1.4, sustain: 0.5, release: 0.3 },
    },
    volume: -10,
    drive: 0.3,
  },
  round: {
    label: 'Round square',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'square' },
      filter: { Q: 1, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.7, release: 0.2 },
      filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.3, release: 0.2, baseFrequency: 110, octaves: 2 },
    },
    volume: -14,
  },
  sub: {
    label: 'Sub',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'triangle' },
      filter: { Q: 0.5, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.03, decay: 0.3, sustain: 0.9, release: 0.5 },
      filterEnvelope: { attack: 0.01, decay: 0.5, sustain: 1, release: 0.5, baseFrequency: 420, octaves: 0 },
    },
    volume: -11,
  },
  disco: {
    label: 'Disco pluck',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'sawtooth' },
      filter: { Q: 3, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.003, decay: 0.22, sustain: 0.35, release: 0.08 },
      filterEnvelope: { attack: 0.002, decay: 0.12, sustain: 0.15, release: 0.1, baseFrequency: 160, octaves: 2.8 },
    },
    volume: -11,
  },
  synthwave: {
    label: 'Synthwave saw',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 12 },
      filter: { Q: 2.5, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.003, decay: 0.15, sustain: 0.55, release: 0.05 },
      filterEnvelope: { attack: 0.002, decay: 0.12, sustain: 0.2, release: 0.08, baseFrequency: 120, octaves: 3 },
    },
    volume: -5,
  },
  mellow: {
    label: 'Mellow',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'triangle' },
      filter: { Q: 1, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.012, decay: 0.6, sustain: 0.45, release: 0.25 },
      filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.4, release: 0.3, baseFrequency: 180, octaves: 1.5 },
    },
    volume: -9,
  },
  drone: {
    label: 'Low drone',
    voice: 'MonoSynth',
    options: {
      oscillator: { type: 'sawtooth' },
      filter: { Q: 1, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.08, decay: 0.8, sustain: 0.85, release: 0.8 },
      filterEnvelope: { attack: 0.15, decay: 1, sustain: 0.5, release: 0.8, baseFrequency: 80, octaves: 2 },
    },
    volume: -13,
  },
};

/**
 * Drum kit:
 * {
 *   label,
 *   kick: { pitchDecay, octaves (start pitch multiplier), decay, note, volume },
 *   snare: 'snare' | 'clap' | 'rim'   which sound plays the groove's snare line,
 *   hat: { decay, volume, cutoff },    closed hat (white noise through a highpass),
 *   ohat: { decay, volume },
 *   perc: one of PERC_SOUNDS            plays the groove's perc line,
 *   space: 0-1 extra reverb on snares/claps (big 80s or cinematic rooms),
 * }
 * Any of kick / snare / hat / perc can be swapped for a recorded sound in
 * the sound slots; the kit is what plays when a slot is left on "synth".
 */
export const KITS = {
  club: {
    label: 'Club',
    kick: { pitchDecay: 0.045, octaves: 7, decay: 0.38, note: 'G1', volume: 0 },
    snare: 'clap',
    hat: { decay: 0.045, volume: -8, cutoff: 7500 },
    ohat: { decay: 0.28, volume: -14 },
    perc: 'shaker',
    space: 0,
  },
  breaks: {
    label: 'Breaks',
    kick: { pitchDecay: 0.045, octaves: 7, decay: 0.38, note: 'G1', volume: 0 },
    snare: 'snare',
    hat: { decay: 0.05, volume: -8, cutoff: 7000 },
    ohat: { decay: 0.3, volume: -14 },
    perc: 'conga',
    space: 0,
  },
  soft: {
    label: 'Soft',
    kick: { pitchDecay: 0.06, octaves: 5, decay: 0.5, note: 'F1', volume: -1 },
    snare: 'snare',
    hat: { decay: 0.045, volume: -8, cutoff: 7500 },
    ohat: { decay: 0.28, volume: -14 },
    perc: 'shaker',
    space: 0.1,
  },
  softclap: {
    label: 'Soft clap',
    kick: { pitchDecay: 0.06, octaves: 5, decay: 0.5, note: 'F1', volume: -1 },
    snare: 'clap',
    hat: { decay: 0.045, volume: -8, cutoff: 7500 },
    ohat: { decay: 0.28, volume: -14 },
    perc: 'shaker',
    space: 0.1,
  },
  lofi: {
    label: 'Lo-fi',
    kick: { pitchDecay: 0.06, octaves: 5, decay: 0.5, note: 'F1', volume: -1 },
    snare: 'rim',
    hat: { decay: 0.04, volume: -10, cutoff: 6000 },
    ohat: { decay: 0.22, volume: -16 },
    perc: 'shaker',
    space: 0,
  },
  disco: {
    label: 'Disco',
    kick: { pitchDecay: 0.04, octaves: 6, decay: 0.34, note: 'A1', volume: 0 },
    snare: 'clap',
    hat: { decay: 0.04, volume: -9, cutoff: 8000 },
    ohat: { decay: 0.26, volume: -13 },
    perc: 'conga',
    space: 0.15,
  },
  trap: {
    label: 'Trap',
    kick: { pitchDecay: 0.035, octaves: 8, decay: 0.3, note: 'F1', volume: 0 },
    snare: 'clap',
    hat: { decay: 0.032, volume: -8, cutoff: 9000 },
    ohat: { decay: 0.22, volume: -15 },
    perc: 'rim',
    space: 0.05,
  },
  phonk: {
    label: 'Phonk',
    kick: { pitchDecay: 0.05, octaves: 7, decay: 0.42, note: 'E1', volume: 0 },
    snare: 'snare',
    hat: { decay: 0.03, volume: -9, cutoff: 8500 },
    ohat: { decay: 0.2, volume: -16 },
    perc: 'cowbell',
    space: 0.1,
  },
  boombap: {
    label: 'Boom bap',
    kick: { pitchDecay: 0.055, octaves: 5, decay: 0.45, note: 'F1', volume: -1 },
    snare: 'snare',
    hat: { decay: 0.035, volume: -10, cutoff: 5000 },
    ohat: { decay: 0.2, volume: -17 },
    perc: 'shaker',
    space: 0.05,
  },
  retro: {
    label: 'Retro',
    kick: { pitchDecay: 0.05, octaves: 6, decay: 0.45, note: 'G1', volume: 0 },
    snare: 'snare',
    hat: { decay: 0.04, volume: -9, cutoff: 7000 },
    ohat: { decay: 0.32, volume: -15 },
    perc: 'tom',
    space: 0.7,
  },
  cinematic: {
    label: 'Cinematic',
    kick: { pitchDecay: 0.08, octaves: 6, decay: 0.7, note: 'D1', volume: -1 },
    snare: 'snare',
    hat: { decay: 0.05, volume: -11, cutoff: 8000 },
    ohat: { decay: 0.45, volume: -17 },
    perc: 'tom',
    space: 0.85,
  },
};

// Built-in percussion voices a kit can use for its perc line.
export const PERC_SOUNDS = {
  shaker: 'Shaker',
  conga: 'Conga',
  tom: 'Toms',
  cowbell: 'Cowbell',
  rim: 'Rimshot',
};

// Background layers that run under the whole song.
export const TEXTURES = {
  none: 'None',
  vinyl: 'Vinyl crackle',
  rain: 'Rain',
  tape: 'Tape hiss',
};
