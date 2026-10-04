// Everything that makes sound. Tone.js is loaded as a global <script>.
//
// The engine only keeps references to its own context and transport, never
// Tone's globals, so the exact same code can render a song offline for the
// WAV export (renderSong builds a second engine on an OfflineAudioContext).

import { TAIL_SECONDS } from './composer.js';
import { SCALES, degreeToMidi, midiToFreq, mod, nearestInSet, voiceChord } from './theory.js';
import { BASS_PATCHES, KITS, PAD_PATCHES, PLUCK_PATCHES } from './patches.js';

const Tone = globalThis.Tone;

export const DEFAULT_FX = { reverb: 50, size: 60, delay: 40, feedback: 40, volume: 80 };
// Mixer faders: 75 is unity gain, 100 is +6 dB, 0 is silent.
export const DEFAULT_MIX = { vox: 75, chords: 75, keys: 75, bass: 75, drums: 75, fx: 75 };
export const MIX_CHANNELS = { vox: 'Vox', chords: 'Chords', keys: 'Keys', bass: 'Bass', drums: 'Drums', fx: 'FX & texture' };
// Drum sounds that can be swapped for recorded noises.
export const SLOTS = { kick: 'Kick', snare: 'Snare', hat: 'Hat', perc: 'Perc' };

const dbToGain = (db) => 10 ** (db / 20);
const KNEE = 0.8;
function softClip(x) {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  return Math.sign(x) * (KNEE + (0.98 - KNEE) * Math.tanh((a - KNEE) / (0.98 - KNEE)));
}
const faderGain = (v) => (v <= 0 ? 0 : dbToGain((v - 75) * 0.24));

// Plays the recorded word at any pitch. Each note is its own one-shot
// buffer source (like Tone.Sampler), but with a fractional root note,
// slices of the word and a reversed copy for swells.
class VoxSampler {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.forward = null;
    this.backward = null;
    this.root = 60;
    this.slices = [];
    this.sampleRate = 44100;
    this.active = new Set();
  }

  load(samples, sampleRate, rootMidi, slices = []) {
    const make = (data) => {
      const buf = this.ctx.createBuffer(1, data.length, sampleRate);
      buf.copyToChannel(data, 0);
      return new Tone.ToneAudioBuffer(buf);
    };
    this.forward = make(samples);
    this.backward = make(Float32Array.from(samples).reverse());
    this.root = rootMidi;
    this.sampleRate = sampleRate;
    this.slices = slices.length > 1 ? slices : [];
  }

  get duration() {
    return this.forward ? this.forward.duration : 0;
  }

  rate(midi) {
    return 2 ** ((midi - this.root) / 12);
  }

  // [start, length] in seconds of slice i (wrapped), or the whole word
  region(slice) {
    if (slice === undefined || slice === null || !this.slices.length) return [0, this.duration];
    const s = this.slices[((slice % this.slices.length) + this.slices.length) % this.slices.length];
    return [s.start / this.sampleRate, (s.end - s.start) / this.sampleRate];
  }

  trigger(midi, time, duration, velocity = 1, { offset = 0, slice, reverse = false, release = 0.05 } = {}) {
    const buffer = reverse ? this.backward : this.forward;
    if (!buffer) return;
    const rate = this.rate(midi);
    let start;
    let span;
    if (slice !== undefined && slice !== null && this.slices.length && !reverse) {
      [start, span] = this.region(slice);
    } else {
      start = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.05));
      span = buffer.duration - start;
    }
    const length = Math.max(0.03, Math.min(duration, span / rate));
    const fadeOut = Math.min(release, length * 0.4);
    const source = new Tone.ToneBufferSource({
      context: this.ctx,
      url: buffer,
      playbackRate: rate,
      fadeIn: 0.004,
      fadeOut,
      curve: 'linear',
    }).connect(this.output);
    source.onended = () => this.active.delete(source);
    source.start(time, start, Math.max(0.01, length - fadeOut), velocity);
    this.active.add(source);
  }

  stopAll(time) {
    for (const source of this.active) {
      try {
        source.stop(time);
      } catch {
        // already stopped
      }
    }
    this.active.clear();
  }
}

// Seeded noise for the generated background textures.
function makeNoise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

// Loopable background layers, generated so there's nothing to download.
function textureBuffer(ctx, kind, sampleRate) {
  const seconds = 4;
  const n = Math.round(seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const rand = makeNoise(kind.length * 7919);
  let l1 = 0;
  let l2 = 0;
  let r1 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand();
    if (kind === 'vinyl') {
      // warm hiss plus sparse crackles and the odd pop
      l1 = l1 * 0.97 + w * 0.03;
      let v = l1 * 0.6;
      if (rand() > 0.4993) v += (rand() > 0 ? 1 : -1) * (0.25 + rand() * 0.5);
      left[i] = v;
      right[i] = v * 0.9 + l1 * 0.1;
    } else if (kind === 'rain') {
      // dark wash with tiny droplets panned around
      l1 = l1 * 0.92 + w * 0.08;
      l2 = l2 * 0.92 + rand() * 0.08;
      left[i] = l1 * 1.2;
      right[i] = l2 * 1.2;
      if (rand() > 0.4985) {
        const amp = 0.08 + rand() * 0.12;
        const pan = rand() + 0.5;
        for (let k = 0; k < 220 && i + k < n; k++) {
          const d = amp * Math.exp(-k / 40) * Math.sin(k * 0.9);
          left[i + k] += d * (1 - pan);
          right[i + k] += d * pan;
        }
      }
    } else {
      // tape: soft broadband hiss with a slow wobble
      r1 = r1 * 0.5 + w * 0.5;
      const wobble = 1 + 0.15 * Math.sin((2 * Math.PI * i) / n);
      left[i] = r1 * 0.35 * wobble;
      right[i] = (r1 * 0.3 + rand() * 0.05) * wobble;
    }
  }
  // fade the loop seam
  const fade = Math.round(0.02 * sampleRate);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    left[i] *= g;
    right[i] *= g;
    left[n - 1 - i] *= g;
    right[n - 1 - i] *= g;
  }
  const buf = ctx.createBuffer(2, n, sampleRate);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  return new Tone.ToneAudioBuffer(buf);
}

const TEXTURE_LEVELS = { vinyl: -21, rain: -19, tape: -27 };
const VOX_LEVEL = dbToGain(-3);
const VOX_LIFT = dbToGain(0); // the chops step forward in the drop
const SLOT_LEVELS = { kick: 0, snare: -3, hat: -9, perc: -6 };

export class Engine {
  constructor({ offline = false, fx = DEFAULT_FX } = {}) {
    if (!Tone) throw new Error('Tone.js did not load');
    this.offline = offline;
    this.ctx = Tone.getContext();
    this.transport = this.ctx.transport;
    this.draw = offline ? null : Tone.getDraw();
    this.song = null;
    this.voice = null;
    this.stepSec = 0.125;
    this.ticksPerStep = this.transport.PPQ / 4;
    this.fx = { ...DEFAULT_FX, ...fx };
    this.mix = { ...DEFAULT_MIX };
    this.mutes = {};
    this.instruments = [];
    this.lastHit = new Map();
    this.playing = false;
    this.slots = {};
    this.textureKind = 'none';
    this.loopDrop = false;
    this.liveMode = false; // chords come from the player instead of the song
    this.live = null;
    this.liveHeld = false;
    this.onEvent = null; // (type, data) for the UI and visuals
    this.onEnd = null;

    // --- master -----------------------------------------------------------
    // Web Audio compressors add their own makeup gain, so the "limiter"
    // overshoots on hard transients. A soft clipper at the very end catches
    // what gets through: transparent below -2 dBFS, never above -0.2 dBFS.
    // (The shaper only sees -1..1, so feed it half the signal and let the
    // curve map that back.)
    // no oversampling: its filters ring past the ceiling
    this.clipper = new Tone.WaveShaper((u) => softClip(u * 2), 8192).toDestination();
    this.trim = new Tone.Gain(dbToGain(-2) * 0.5).connect(this.clipper);
    this.limiter = new Tone.Limiter(-1).connect(this.trim);
    this.glue = new Tone.Compressor({ threshold: -14, ratio: 2.5, attack: 0.02, release: 0.25 }).connect(this.limiter);
    // performance filters (the XY pad) sit on the whole mix
    this.perfHighpass = new Tone.Filter({ type: 'highpass', frequency: 10, Q: 0.9, rolloff: -12 }).connect(this.glue);
    this.perfLowpass = new Tone.Filter({ type: 'lowpass', frequency: 20000, Q: 0.9, rolloff: -12 }).connect(this.perfHighpass);
    this.airShelf = new Tone.Filter({ type: 'highshelf', frequency: 5500, gain: 2.5 }).connect(this.perfLowpass);
    this.lowShelf = new Tone.Filter({ type: 'lowshelf', frequency: 140, gain: -2 }).connect(this.airShelf);
    this.master = new Tone.Gain(1).connect(this.lowShelf);
    // instruments go through `dry`; effect returns join at `master`, so the
    // XY pad's echo throw can tap the dry mix without feeding back
    this.dry = new Tone.Gain(1).connect(this.master);
    if (!offline) {
      this.analyser = new Tone.Waveform(512);
      this.fft = new Tone.FFT({ size: 256, smoothing: 0.75 });
      this.clipper.fan(this.analyser, this.fft);
    }

    // --- shared FX returns ------------------------------------------------
    this.reverb = new Tone.Reverb({ decay: this._decayFor(this.fx.size), preDelay: 0.02, wet: 1 });
    this.reverbReturn = new Tone.Gain(0.5).connect(this.master);
    this.reverb.connect(this.reverbReturn);
    this.delay = new Tone.PingPongDelay({ delayTime: 0.3, feedback: 0.4, wet: 1, maxDelay: 2 });
    this.delayTone = new Tone.Filter({ type: 'lowpass', frequency: 4200, rolloff: -12 });
    this.delayReturn = new Tone.Gain(0.4).connect(this.master);
    this.delay.chain(this.delayTone, this.delayReturn);
    this.delayTone.connect(new Tone.Gain(0.25).connect(this.reverb));
    this.throwSend = new Tone.Gain(0).connect(this.delay);
    this.dry.connect(this.throwSend);
    this.ready = this.reverb.ready;

    const bus = (rev, dly) => {
      const input = new Tone.Gain(1).connect(this.dry);
      const revSend = new Tone.Gain(rev).connect(this.reverb);
      const dlySend = new Tone.Gain(dly).connect(this.delay);
      input.fan(revSend, dlySend);
      return { input, revSend, dlySend, baseDelay: dly };
    };
    this.buses = {
      vox: bus(0.55, 0.45),
      pad: bus(0.35, 0),
      keys: bus(0.3, 0.22),
      drums: bus(0.12, 0),
      fx: bus(0.5, 0.1),
    };

    // --- mixer channels -------------------------------------------------------
    this.channels = {
      vox: new Tone.Gain(1).connect(this.buses.vox.input),
      chords: new Tone.Gain(1).connect(this.buses.pad.input),
      keys: new Tone.Gain(1).connect(this.buses.keys.input),
      bass: new Tone.Gain(1).connect(this.dry),
      drums: new Tone.Gain(1).connect(this.buses.drums.input),
      kick: new Tone.Gain(1).connect(this.dry), // follows the drums fader
      fx: new Tone.Gain(1).connect(this.buses.fx.input),
    };

    // --- vocal chops, with an optional "8D" orbit around the listener -----
    this.voxIn = new Tone.Gain(1);
    this.voxHighpass = new Tone.Filter({ type: 'highpass', frequency: 130 });
    this.voxComp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.005, release: 0.12 });
    this.voxPresence = new Tone.Filter({ type: 'highshelf', frequency: 3200, gain: 4 });
    this.voxLevel = new Tone.Gain(VOX_LEVEL);
    this.voxIn.chain(this.voxHighpass, this.voxPresence, this.voxComp, this.voxLevel);
    this.voxDry = new Tone.Gain(1).connect(this.channels.vox);
    this.voxOrbitGain = new Tone.Gain(0).connect(this.channels.vox);
    this.orbit = new Tone.Panner3D({
      panningModel: 'HRTF',
      distanceModel: 'linear',
      refDistance: 1,
      maxDistance: 10,
      rolloffFactor: 0.15,
      positionX: 0,
      positionY: 0,
      positionZ: -1.5,
    }).connect(this.voxOrbitGain);
    // the HRTF panner only joins the chain while 8D is on (it isn't free)
    this.voxLevel.connect(this.voxDry);
    this.orbitX = new Tone.LFO({ frequency: 0.12, min: -1.8, max: 1.8 }).connect(this.orbit.positionX);
    this.orbitZ = new Tone.LFO({ frequency: 0.12, min: -1.8, max: 1.8, phase: 90 }).connect(this.orbit.positionZ);
    this.orbitOn = false;
    this.sampler = new VoxSampler(this.ctx, this.voxIn);

    // --- pad / keys / bass chains (synths are swapped per song) ----------
    this.padFilter = new Tone.Filter({ type: 'lowpass', frequency: 1200, Q: 0.6, rolloff: -24 });
    this.padChorus = new Tone.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.6, wet: 0 });
    this.padPump = new Tone.Gain(1);
    this.padFilter.chain(this.padChorus, this.padPump, this.channels.chords);
    if (offline) this.padChorus.start(0);
    else this.padChorus.start();

    this.keysFilter = new Tone.Filter({ type: 'lowpass', frequency: 5000, rolloff: -12 });
    this.keysPump = new Tone.Gain(1);
    this.keysFilter.chain(this.keysPump, this.channels.keys);

    this.bassPump = new Tone.Gain(1).connect(this.channels.bass);

    // --- drums --------------------------------------------------------------
    const drums = this.channels.drums;
    // extra room on snares and claps, for 80s and cinematic kits
    this.snareSpace = new Tone.Gain(0).connect(this.reverb);
    this.hatFilter = new Tone.Filter({ type: 'highpass', frequency: 7500 }).connect(drums);
    this.hat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.01 },
      volume: -8,
    }).connect(this.hatFilter);
    this.ohat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.002, decay: 0.28, sustain: 0, release: 0.05 },
      volume: -14,
    }).connect(this.hatFilter);

    this.snareTone = new Tone.Filter({ type: 'highpass', frequency: 900 }).fan(drums, this.snareSpace);
    this.snareNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.17, sustain: 0, release: 0.03 },
      volume: -6,
    }).connect(this.snareTone);
    this.snareBody = new Tone.MembraneSynth({
      pitchDecay: 0.02,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 },
      volume: -10,
    }).fan(drums, this.snareSpace);

    this.clapTone = new Tone.Filter({ type: 'bandpass', frequency: 1400, Q: 1.1 }).fan(drums, this.snareSpace);
    this.clap = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.13, sustain: 0, release: 0.04 },
      volume: 2,
    }).connect(this.clapTone);

    this.rim = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
      volume: -7,
    }).fan(drums, this.snareSpace);

    this.crashFilter = new Tone.Filter({ type: 'highpass', frequency: 4500 }).connect(drums);
    this.crash = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 0.2 },
      volume: -12,
    }).connect(this.crashFilter);

    // --- risers, impacts, textures ----------------------------------------
    this.riserGain = new Tone.Gain(0).connect(this.channels.fx);
    this.riserFilter = new Tone.Filter({ type: 'bandpass', frequency: 300, Q: 2.5 }).connect(this.riserGain);
    // runs the whole time; the riser is just its gain and filter moving
    this.riserNoise = new Tone.Noise('white').connect(this.riserFilter);
    this.riserNoise.start(offline ? 0 : undefined);
    this.subDrop = new Tone.MembraneSynth({
      pitchDecay: 1,
      octaves: 3,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 1.6, sustain: 0, release: 0.2 },
      volume: -4,
    }).connect(this.channels.kick);
    this.textureGain = new Tone.Gain(0).connect(this.channels.fx);
    this.texturePlayer = null;

    this.setFx(this.fx);
  }

  _decayFor(size) {
    return 1 + (size / 100) * 9;
  }

  _setParam(param, value) {
    if (this.offline || !this.playing) param.value = value;
    else param.rampTo(value, 0.08);
  }

  _emit(type, data, time) {
    if (!this.draw || !this.onEvent) return;
    this.draw.schedule(() => this.onEvent?.(type, data), time);
  }

  setFx(partial) {
    this.fx = { ...this.fx, ...partial };
    const f = this.fx;
    this._setParam(this.reverbReturn.gain, (f.reverb / 100) * 1.1);
    this._setParam(this.delayReturn.gain, (f.delay / 100) * 0.9);
    this._setParam(this.delay.feedback, (f.feedback / 100) * 0.82);
    this._setParam(this.master.gain, f.volume <= 0 ? 0 : dbToGain((f.volume - 80) * 0.25 - 3));
    const decay = this._decayFor(f.size);
    if (Math.abs(decay - Number(this.reverb.decay)) > 0.05) {
      // regenerating the impulse response is async; don't do it per pixel
      clearTimeout(this._decayTimer);
      if (this.offline) this.reverb.decay = decay;
      else this._decayTimer = setTimeout(() => (this.reverb.decay = decay), 180);
    }
  }

  setMix(levels = {}, mutes = this.mutes) {
    this.mix = { ...this.mix, ...levels };
    this.mutes = { ...mutes };
    for (const name of Object.keys(DEFAULT_MIX)) {
      const g = this.mutes[name] ? 0 : faderGain(this.mix[name]);
      this._setParam(this.channels[name].gain, g);
      if (name === 'drums') this._setParam(this.channels.kick.gain, g);
    }
  }

  // Swing the vocal chops around the listener's head (best on headphones).
  // One lap takes four bars of the current song.
  setOrbit(on) {
    if (on && !this.orbitOn) this.voxLevel.connect(this.orbit);
    if (!on && this.orbitOn) this.voxLevel.disconnect(this.orbit);
    this.orbitOn = on;
    if (on) {
      if (this.orbitX.state !== 'started') {
        const t = this.offline ? 0 : undefined;
        this.orbitX.start(t);
        this.orbitZ.start(t);
      }
    }
    this._setParam(this.voxDry.gain, on ? 0 : 1);
    this._setParam(this.voxOrbitGain.gain, on ? 1.25 : 0);
  }

  // x 0..1: left closes a lowpass, right opens a highpass, middle is clean.
  // y 0..1: how much of the whole mix gets thrown into the delay.
  setPerformance({ x = 0.5, y = 0 } = {}) {
    const now = this.ctx.now();
    const lp = x < 0.5 ? 20000 * (180 / 20000) ** ((0.5 - x) * 2) : 20000;
    const hp = x > 0.5 ? 10 * (2500 / 10) ** ((x - 0.5) * 2) : 10;
    this.perfLowpass.frequency.cancelScheduledValues(now);
    this.perfLowpass.frequency.rampTo(lp, 0.05, now);
    this.perfHighpass.frequency.cancelScheduledValues(now);
    this.perfHighpass.frequency.rampTo(hp, 0.05, now);
    this.throwSend.gain.cancelScheduledValues(now);
    this.throwSend.gain.rampTo(Math.max(0, Math.min(1, y)) * 0.7, 0.05, now);
  }

  setVoice(voice) {
    this.voice = voice;
    this.sampler.load(voice.samples, voice.sampleRate, voice.rootMidi, voice.slices ?? []);
  }

  // A recorded noise for a drum slot, or null to go back to the synth.
  setSlot(name, sound, { tune = 0 } = {}) {
    if (!SLOTS[name]) return;
    if (!sound) {
      delete this.slots[name];
      return;
    }
    const buf = this.ctx.createBuffer(1, sound.samples.length, sound.sampleRate);
    buf.copyToChannel(sound.samples, 0);
    this.slots[name] = { buffer: new Tone.ToneAudioBuffer(buf), tune };
  }

  setSlotTune(name, tune) {
    if (this.slots[name]) this.slots[name].tune = tune;
  }

  _playSlot(name, time, vel, { rate = 1, maxLen = 2, dest } = {}) {
    const slot = this.slots[name];
    if (!slot) return false;
    const playbackRate = rate * 2 ** (slot.tune / 12);
    const length = Math.min(maxLen, slot.buffer.duration / playbackRate);
    const source = new Tone.ToneBufferSource({
      context: this.ctx,
      url: slot.buffer,
      playbackRate,
      fadeIn: 0.001,
      fadeOut: Math.min(0.03, length * 0.3),
      curve: 'linear',
    });
    source.connect(dest ?? this.channels.drums);
    if (name === 'snare') source.connect(this.snareSpace);
    source.onended = () => {};
    source.start(time, 0, Math.max(0.01, length), vel * dbToGain(SLOT_LEVELS[name]));
    return true;
  }

  // Swap the synths for the ones this song's style asks for.
  _buildInstruments(style) {
    for (const inst of this.instruments) inst.dispose();
    this.perc?.dispose?.();
    const pad = PAD_PATCHES[style.pad] ?? PAD_PATCHES.warm;
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: pad.oscillator,
      envelope: pad.envelope,
      volume: pad.volume,
    }).connect(this.padFilter);
    this.pad.maxPolyphony = 24;
    this.padChorus.wet.value = pad.chorus;

    const pluck = PLUCK_PATCHES[style.pluck] ?? PLUCK_PATCHES.pluck;
    this.keys = new Tone.PolySynth(Tone[pluck.voice] ?? Tone.Synth, { ...pluck.options, volume: pluck.volume }).connect(this.keysFilter);
    this.keys.maxPolyphony = 24;
    this.keysFilter.frequency.value = pluck.cutoff;

    const bass = BASS_PATCHES[style.bass] ?? BASS_PATCHES.sub;
    this.bass = new (Tone[bass.voice] ?? Tone.MonoSynth)({ ...bass.options, volume: bass.volume });
    this.bassDrive = bass.drive ? new Tone.Distortion(bass.drive).connect(this.bassPump) : null;
    this.bass.connect(this.bassDrive ?? this.bassPump);

    const kit = KITS[style.kit] ?? KITS.club;
    this.kit = kit;
    this.kick = new Tone.MembraneSynth({
      pitchDecay: kit.kick.pitchDecay,
      octaves: kit.kick.octaves,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: kit.kick.decay, sustain: 0, release: 0.1 },
      volume: kit.kick.volume,
    }).connect(this.channels.kick);
    this.kickNote = kit.kick.note;
    this.hat.envelope.decay = kit.hat.decay;
    this.hat.volume.value = kit.hat.volume;
    this.ohat.envelope.decay = kit.ohat.decay;
    this.ohat.volume.value = kit.ohat.volume;
    this.hatFilter.frequency.value = kit.hat.cutoff;
    this.snareSpace.gain.value = (kit.space ?? 0) * 0.8;
    this.perc = this._makePerc(kit.perc);

    this.instruments = [this.pad, this.keys, this.bass, this.kick, this.bassDrive, this.perc?.node].filter(Boolean);
    this.lastHit.clear();
  }

  _makePerc(kind) {
    const out = this.channels.drums;
    switch (kind) {
      case 'conga': {
        const node = new Tone.MembraneSynth({
          pitchDecay: 0.02,
          octaves: 1.5,
          envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.05 },
          volume: -8,
        }).connect(out);
        return { node, hit: (t, vel, step) => node.triggerAttackRelease(step % 4 === 0 ? 'A3' : 'D4', 0.15, t, vel) };
      }
      case 'tom': {
        const node = new Tone.MembraneSynth({
          pitchDecay: 0.06,
          octaves: 2.2,
          envelope: { attack: 0.002, decay: 0.55, sustain: 0, release: 0.1 },
          volume: -4,
        }).fan(out, this.snareSpace);
        const toms = ['D3', 'A2', 'F2', 'C2'];
        return { node, hit: (t, vel, step) => node.triggerAttackRelease(toms[Math.floor(step) % toms.length], 0.4, t, vel) };
      }
      case 'cowbell': {
        const tone = new Tone.Filter({ type: 'bandpass', frequency: 1800, Q: 1.4 }).connect(out);
        const node = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'square' },
          envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 },
          volume: -20,
        }).connect(tone);
        node.maxPolyphony = 6;
        return {
          node,
          dispose: () => tone.dispose(),
          hit: (t, vel) => node.triggerAttackRelease([540, 800], 0.06, t, vel),
        };
      }
      case 'rim':
        return { node: null, hit: (t, vel) => this._rim(t, vel) };
      default: {
        // shaker
        const tone = new Tone.Filter({ type: 'bandpass', frequency: 6500, Q: 0.8 }).connect(out);
        const node = new Tone.NoiseSynth({
          noise: { type: 'white' },
          envelope: { attack: 0.004, decay: 0.06, sustain: 0, release: 0.02 },
          volume: -12,
        }).connect(tone);
        return { node, dispose: () => tone.dispose(), hit: (t, vel) => node.triggerAttackRelease(0.04, t, vel) };
      }
    }
  }

  _setTexture(kind) {
    if (kind === this.textureKind && this.texturePlayer) return;
    this.texturePlayer?.dispose();
    this.texturePlayer = null;
    this.textureKind = kind;
    if (!kind || kind === 'none' || !TEXTURE_LEVELS[kind]) return;
    const buffer = textureBuffer(this.ctx, kind, this.ctx.sampleRate);
    this.texturePlayer = new Tone.Player({ url: buffer, loop: true, fadeIn: 0.5, fadeOut: 0.5 }).connect(this.textureGain);
    this.textureGain.gain.value = dbToGain(TEXTURE_LEVELS[kind]);
  }

  // Monophonic Tone instruments refuse two starts at the same instant.
  _hitTime(key, time) {
    const last = this.lastHit.get(key) ?? -1;
    const t = time <= last ? last + 0.002 : time;
    this.lastHit.set(key, t);
    return t;
  }

  _pump(time, depth) {
    if (!depth) return;
    const release = Math.min(0.3, this.stepSec * 3.2);
    for (const [gain, amount] of [
      [this.padPump.gain, depth],
      [this.keysPump.gain, depth * 0.8],
      [this.bassPump.gain, depth * 0.5],
    ]) {
      gain.cancelAndHoldAtTime(time);
      gain.setValueAtTime(1 - amount, time);
      gain.linearRampToValueAtTime(1, time + release);
    }
  }

  _kick(time, vel) {
    if (this._playSlot('kick', time, vel, { dest: this.channels.kick, maxLen: 0.8 })) return;
    this.kick.triggerAttackRelease(this.kickNote, 0.3, this._hitTime('kick', time), vel);
  }

  _snare(time, vel) {
    if (this._playSlot('snare', time, vel, { maxLen: 0.6 })) return;
    this.snareNoise.triggerAttackRelease(0.15, this._hitTime('snareNoise', time), vel);
    this.snareBody.triggerAttackRelease('G3', 0.1, this._hitTime('snareBody', time), vel * 0.8);
  }

  _clap(time, vel) {
    if (this._playSlot('snare', time, vel, { maxLen: 0.6 })) return;
    const t = this._hitTime('clap', time);
    this.clap.triggerAttackRelease(0.01, t, vel * 0.6);
    this.clap.triggerAttackRelease(0.01, t + 0.011, vel * 0.7);
    this.clap.triggerAttackRelease(0.06, t + 0.022, vel);
    this.lastHit.set('clap', t + 0.022);
  }

  _rim(time, vel) {
    if (this._playSlot('snare', time, vel, { maxLen: 0.6 })) return;
    this.rim.triggerAttackRelease('E5', 0.04, this._hitTime('rim', time), vel);
  }

  // the groove's backbeat, in whatever sound the kit uses for it
  _kitSnare(time, vel) {
    const kind = this.kit?.snare;
    if (kind === 'clap') this._clap(time, vel);
    else if (kind === 'rim') this._rim(time, vel);
    else this._snare(time, vel);
  }

  _hat(time, vel, open = false) {
    if (this._playSlot('hat', time, open ? vel * 0.8 : vel, { maxLen: open ? 0.5 : 0.12 })) return;
    if (open) this.ohat.triggerAttackRelease(0.1, this._hitTime('ohat', time), vel);
    else this.hat.triggerAttackRelease(0.03, this._hitTime('hat', time), vel);
  }

  _percHit(time, vel, step) {
    if (this._playSlot('perc', time, vel, { maxLen: 0.5 })) return;
    if (!this.perc) return;
    this.perc.hit(this._hitTime('perc', time), vel, step);
  }

  load(song) {
    this.stop();
    this.transport.cancel(0);
    this.song = song;
    this.transport.bpm.value = song.bpm;
    this.stepSec = 60 / song.bpm / 4;
    this.ticksPerStep = this.transport.PPQ / 4;
    this.delay.delayTime.value = this.stepSec * 3; // dotted 8th
    this._buildInstruments(song.style);
    this._setTexture(song.style.texture);
    this.orbitX.frequency.value = this.orbitZ.frequency.value = 1 / (this.stepSec * 16 * 4); // one lap per 4 bars

    const swingOffset = song.swing * this.stepSec;
    const at = (step, fn) => {
      const swing = Number.isInteger(step) && step % 2 === 1 ? swingOffset : 0;
      this.transport.schedule((time) => fn(time + swing), `${Math.round(step * this.ticksPerStep)}i`);
    };
    const sec = (steps) => steps * this.stepSec;
    const T = song.tracks;

    for (const e of T.pad) {
      const freqs = e.notes.map(midiToFreq);
      at(e.step, (t) => {
        const live = this._liveNow();
        if (live) {
          if (!this.liveHeld) this.pad.triggerAttackRelease(live.voicing.map(midiToFreq), sec(e.dur), t, e.vel);
          return;
        }
        this.pad.triggerAttackRelease(freqs, sec(e.dur), t, e.vel);
        const chord = song.chords[e.chord];
        if (chord) this._emit('chord', { index: e.chord, symbol: chord.symbol }, t);
      });
    }
    for (const e of T.keys) {
      const freqs = e.notes.map(midiToFreq);
      at(e.step, (t) => {
        const live = this._liveNow();
        const notes = live ? e.notes.map((n) => nearestInSet(n, live.pcs)).map(midiToFreq) : freqs;
        this.keys.triggerAttackRelease(notes, sec(e.dur), t, e.vel);
      });
    }
    for (const e of T.bass) {
      at(e.step, (t) => {
        const live = this._liveNow();
        let note = e.note;
        if (live) {
          const from = song.chords[e.chord]?.bass ?? e.note;
          note = nearestInSet(live.bassMidi + (e.note - from), live.pcs);
        }
        this.bass.triggerAttackRelease(midiToFreq(note), sec(e.dur), this._hitTime('bass', t), e.vel);
      });
    }
    for (const e of T.vox) {
      at(e.step, (t) => {
        const offset = e.offset === 'vowel' && this.voice ? this.voice.vowelOffset : 0;
        const midi = this._liveVox(e);
        this.sampler.trigger(midi, t, sec(e.dur), e.vel, { offset, slice: e.slice });
        this._emit('vox', { midi, dur: sec(e.dur), vel: e.vel, slice: e.slice }, t);
      });
    }
    for (const e of T.voxRev) {
      // a reversed copy of the word that swells up and ends right on the drop
      const length = this.sampler.duration / this.sampler.rate(e.midi);
      const startStep = Math.max(0, e.step - Math.min(length, sec(16)) / this.stepSec);
      const startTick = Math.round(startStep * this.ticksPerStep);
      const swellLen = sec(e.step) - (startTick / this.ticksPerStep) * this.stepSec;
      this.transport.schedule((t) => {
        const skip = Math.max(0, this.sampler.duration - swellLen * this.sampler.rate(e.midi));
        this.sampler.trigger(e.midi, t, swellLen, e.vel, { reverse: true, offset: skip, release: 0.01 });
      }, `${startTick}i`);
    }

    for (const e of T.kick) {
      at(e.step, (t) => {
        this._kick(t, e.vel);
        this._pump(t, e.pump);
        this._emit('kick', { vel: e.vel }, t);
      });
    }
    for (const e of T.snare) {
      at(e.step, (t) => {
        this._kitSnare(t, e.vel);
        this._emit('snare', { vel: e.vel }, t);
      });
    }
    for (const e of T.roll) {
      at(e.step, (t) => {
        this._snare(t, e.vel);
        this._emit('snare', { vel: e.vel * 0.6 }, t);
      });
    }
    for (const e of T.hat) {
      at(e.step, (t) => {
        this._hat(t, e.vel);
        this._emit('hat', { vel: e.vel }, t);
      });
    }
    for (const e of T.ohat) {
      at(e.step, (t) => {
        this._hat(t, e.vel, true);
        this._emit('hat', { vel: e.vel, open: true }, t);
      });
    }
    for (const e of T.perc ?? []) {
      at(e.step, (t) => {
        this._percHit(t, e.vel, e.step);
        this._emit('perc', { vel: e.vel }, t);
      });
    }
    for (const e of T.crash) at(e.step, (t) => this.crash.triggerAttackRelease(1, this._hitTime('crash', t), e.vel));

    for (const a of song.automation) {
      at(a.step, (t) => this._automate(a, t));
    }
    for (const s of song.sections) {
      at(s.startStep, (t) => this._emit('section', { id: s.id, name: s.name }, t));
    }
    this.setLoopDrop(this.loopDrop);
    const endTick = Math.round((song.totalSteps + TAIL_SECONDS / this.stepSec) * this.ticksPerStep);
    this.transport.schedule((t) => {
      if (this.draw) {
        this.draw.schedule(() => {
          this.stop();
          this.onEnd?.();
        }, t);
      }
    }, `${endTick}i`);
  }

  _liveNow() {
    return this.liveMode && this.live ? this.live : null;
  }

  // Move a chop to follow the live chord: shift it by the same number of
  // scale steps the chord moved, then make sure held notes sit on a chord tone.
  _liveVox(e) {
    const live = this._liveNow();
    if (!live || !this.song) return e.midi;
    const song = this.song;
    const from = song.chords[e.chord]?.root;
    let midi = e.midi;
    if (live.degree >= 0 && from !== undefined) {
      const shift = mod(live.degree - from + 3, 7) - 3;
      midi = degreeToMidi(song.melodyTonic, SCALES[song.mode], e.deg + shift);
    }
    if (live.degree < 0 || e.dur >= 2) midi = nearestInSet(midi, live.pcs);
    return midi;
  }

  setLiveMode(on) {
    this.liveMode = on;
    if (!on) {
      this.releaseLive();
      this.live = null;
    }
  }

  /**
   * Play a chord the player picked: { rootPc, pcs, symbol, degree }. While
   * the song runs, it replaces the song's chord until the next one; when
   * stopped it rings like an instrument until releaseLive().
   */
  liveChord(chord) {
    if (!this.pad) return;
    const t = this.ctx.immediate() + 0.01;
    const voicing = voiceChord(chord.pcs, this.live?.voicing ?? null, { low: 50, high: 74, center: 61 });
    const bassMidi = 33 + mod(chord.rootPc - 33, 12);
    this.releaseLive(t);
    this.live = { ...chord, voicing, bassMidi };
    if (this.playing) {
      // ring until the end of the bar; the song's next pad hit takes over
      const left = this.stepSec * (16 - (this.position % 16));
      const dur = Math.max(this.stepSec * 4, left);
      this.pad.triggerAttackRelease(voicing.map(midiToFreq), dur, t, 0.75);
      this.bass.triggerAttackRelease(midiToFreq(bassMidi), Math.min(dur, this.stepSec * 4), this._hitTime('bass', t), 0.85);
    } else {
      this.pad.triggerAttack(voicing.map(midiToFreq), t, 0.75);
      this.bass.triggerAttack(midiToFreq(bassMidi), this._hitTime('bass', t), 0.85);
      this.liveHeld = true;
    }
    this.onEvent?.('chord', { index: -1, symbol: chord.symbol, live: true });
  }

  releaseLive(time = this.ctx.immediate()) {
    if (this.live && this.liveHeld) {
      this.pad?.triggerRelease(this.live.voicing.map(midiToFreq), time);
      this.bass?.triggerRelease(time);
    }
    this.liveHeld = false;
  }

  // Loop the drop forever (for jamming over it).
  setLoopDrop(on) {
    const drop = this.song?.sections.find((s) => s.id === 'drop');
    this.loopDrop = on;
    if (!on || !drop) {
      this.transport.loop = false;
      return;
    }
    this.transport.loopStart = `${Math.round(drop.startStep * this.ticksPerStep)}i`;
    this.transport.loopEnd = `${Math.round(drop.endStep * this.ticksPerStep)}i`;
    this.transport.loop = true;
  }

  _automate(a, t) {
    switch (a.type) {
      case 'padFilter': {
        const f = this.padFilter.frequency;
        f.cancelScheduledValues(t);
        f.setValueAtTime(a.from, t);
        f.exponentialRampToValueAtTime(Math.max(40, a.to), t + Math.max(0.01, a.steps * this.stepSec));
        break;
      }
      case 'riser': {
        const end = t + a.steps * this.stepSec;
        const g = this.riserGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(0.0001, t);
        g.exponentialRampToValueAtTime(0.32, end);
        g.setValueAtTime(0, end);
        const f = this.riserFilter.frequency;
        f.cancelScheduledValues(t);
        f.setValueAtTime(300, t);
        f.exponentialRampToValueAtTime(9000, end);
        break;
      }
      case 'impact':
        this.subDrop.triggerAttackRelease('A0', 1.2, this._hitTime('subDrop', t), 0.9);
        this._emit('impact', {}, t);
        break;
      case 'gap': {
        // pull the effect tails and the riser out for the breath before the drop
        const end = t + a.steps * this.stepSec;
        for (const [gain, back] of [
          [this.reverbReturn.gain, (this.fx.reverb / 100) * 1.1],
          [this.delayReturn.gain, (this.fx.delay / 100) * 0.9],
        ]) {
          gain.cancelScheduledValues(t);
          gain.setValueAtTime(gain.getValueAtTime(t), t);
          gain.linearRampToValueAtTime(0, t + 0.06);
          gain.setValueAtTime(0, end - 0.01);
          gain.linearRampToValueAtTime(back, end);
        }
        this.riserGain.gain.cancelScheduledValues(t);
        this.riserGain.gain.setValueAtTime(0, t + 0.02);
        break;
      }
      case 'voxLift':
        this.voxLevel.gain.cancelScheduledValues(t);
        this.voxLevel.gain.setValueAtTime(a.on ? VOX_LIFT : VOX_LEVEL, t);
        break;
      case 'voxEcho': {
        const g = this.buses.vox.dlySend.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(this.buses.vox.baseDelay, t);
        g.linearRampToValueAtTime(this.buses.vox.baseDelay * 1.9, t + 16 * this.stepSec);
        break;
      }
      default:
        break;
    }
  }

  _resetAutomation(time) {
    for (const g of [this.padPump.gain, this.keysPump.gain, this.bassPump.gain]) {
      g.cancelScheduledValues(time);
      g.setValueAtTime(1, time);
    }
    const voxDelay = this.buses.vox.dlySend.gain;
    voxDelay.cancelScheduledValues(time);
    voxDelay.setValueAtTime(this.buses.vox.baseDelay, time);
    this.riserGain.gain.cancelScheduledValues(time);
    this.riserGain.gain.setValueAtTime(0, time);
    this.voxLevel.gain.cancelScheduledValues(time);
    const inDrop = this.song?.sections.find((s) => s.id === 'drop');
    const step = this._startStep ?? 0;
    this.voxLevel.gain.setValueAtTime(inDrop && step >= inDrop.startStep && step < inDrop.endStep ? VOX_LIFT : VOX_LEVEL, time);
    for (const [gain, v] of [
      [this.reverbReturn.gain, (this.fx.reverb / 100) * 1.1],
      [this.delayReturn.gain, (this.fx.delay / 100) * 0.9],
    ]) {
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(v, time);
    }
    this.padFilter.frequency.cancelScheduledValues(time);
    this.padFilter.frequency.setValueAtTime(this.song ? this.song.style.padFilter[0] : 1200, time);
  }

  // Tracked by hand: right after start() the transport still reports
  // "stopped" until its (slightly delayed) start time arrives.
  get isPlaying() {
    return this.playing;
  }

  play(fromStep = 0) {
    if (!this.song) return;
    if (this.isPlaying) this.stop();
    const time = this.offline ? 0 : this.ctx.now() + 0.05;
    this._startStep = fromStep;
    this._resetAutomation(time);
    this.lastHit.clear();
    // start one tick early so events sitting exactly on the start step fire
    const tick = Math.max(0, Math.round(fromStep * this.ticksPerStep) - 1);
    this.transport.start(time, `${tick}i`);
    if (this.texturePlayer?.loaded) this.texturePlayer.start(time);
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.liveHeld = false;
    this.transport.stop(); // also cancels a start that hasn't kicked in yet
    const now = this.ctx.now();
    this.pad?.releaseAll(now);
    this.keys?.releaseAll(now);
    this.bass?.triggerRelease(now);
    this.sampler.stopAll(now);
    this.riserGain.gain.cancelScheduledValues(now);
    this.riserGain.gain.setValueAtTime(0, now);
    if (this.texturePlayer?.state === 'started') this.texturePlayer.stop(now);
    this.lastHit.clear();
  }

  // Current position in 16th-note steps.
  get position() {
    if (!this.isPlaying) return 0;
    return Math.max(0, this.transport.getTicksAtTime(this.ctx.immediate()) / this.ticksPerStep);
  }

  // Play the word at a pitch, right now (for the on-screen keyboard).
  audition(midi, duration = 2, slice) {
    const t = this.ctx.immediate() + 0.01;
    this.sampler.trigger(midi, t, duration, 0.9, { release: 0.08, slice });
    this.onEvent?.('vox', { midi, dur: duration, vel: 0.9, slice });
  }

  // Jam pads: fire a slice of the word on the next 16th so it lands in time.
  jamSlice(slice, midi) {
    const pitch = midi ?? (this.song ? this.song.melodyTonic : Math.round(this.sampler.root));
    const t = this.playing ? this.transport.nextSubdivision('16n') : this.ctx.immediate() + 0.01;
    this.sampler.trigger(pitch, t, 1.5, 0.95, { slice, release: 0.04 });
    this._emit('vox', { midi: pitch, dur: 0.3, vel: 0.95, slice }, t);
  }

  // Audition a drum slot (recorded noise or the kit's synth).
  auditionSlot(name) {
    const t = this.ctx.immediate() + 0.01;
    if (!this.kit) this._buildInstruments(this.song?.style ?? { pad: 'warm', pluck: 'pluck', bass: 'sub', kit: 'club' });
    if (name === 'kick') this._kick(t, 0.9);
    else if (name === 'snare') this._kitSnare(t, 0.9);
    else if (name === 'hat') this._hat(t, 0.9);
    else if (name === 'perc') this._percHit(t, 0.9, 0);
  }

  dispose() {
    this.stop();
    this.transport.cancel(0);
  }
}

/**
 * Render a whole song to an AudioBuffer, offline and faster than real time
 * (on most machines). Builds a second engine on its own OfflineAudioContext;
 * using a native context lets us suspend() along the way to report progress.
 */
export async function renderSong({ song, voice, fx, mix, mutes, slots = {}, orbit = false, onProgress = () => {}, sampleRate = 44100 }) {
  const duration = song.durationSec + TAIL_SECONDS;
  const native = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const offline = new Tone.OfflineContext(native);
  const original = Tone.getContext();
  Tone.setContext(offline);
  try {
    const engine = new Engine({ offline: true, fx });
    await engine.ready;
    engine.setVoice(voice);
    for (const [name, slot] of Object.entries(slots)) {
      if (slot?.sound) engine.setSlot(name, slot.sound, { tune: slot.tune ?? 0 });
    }
    if (mix) engine.setMix(mix, mutes ?? {});
    engine.load(song);
    if (orbit) engine.setOrbit(true);
    engine.play(0);
  } finally {
    Tone.setContext(original);
  }
  for (let t = 1; t < duration; t += 1) {
    native.suspend(t).then(() => {
      onProgress(t / duration);
      native.resume();
    });
  }
  const buffer = await offline.render();
  onProgress(1);
  return buffer.get();
}
