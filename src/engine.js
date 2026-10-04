// Everything that makes sound. Tone.js is loaded as a global <script>.
//
// The engine only keeps references to its own context and transport, never
// Tone's globals, so the exact same code can render a song offline for the
// WAV export (Tone.Offline swaps the global context back while rendering).

import { TAIL_SECONDS } from './composer.js';
import { midiToFreq } from './theory.js';

const Tone = globalThis.Tone;

export const DEFAULT_FX = { reverb: 50, size: 60, delay: 40, feedback: 40, volume: 80 };

const PAD_PATCHES = {
  supersaw: {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
    envelope: { attack: 0.03, decay: 0.3, sustain: 0.8, release: 0.9 },
    volume: -13,
    chorus: 0,
  },
  warm: {
    oscillator: { type: 'fatsawtooth', count: 2, spread: 14 },
    envelope: { attack: 0.5, decay: 1, sustain: 0.8, release: 2.2 },
    volume: -10,
    chorus: 0.4,
  },
  felt: {
    oscillator: { type: 'fattriangle', count: 3, spread: 18 },
    envelope: { attack: 0.25, decay: 1.2, sustain: 0.6, release: 2 },
    volume: -6,
    chorus: 0.5,
  },
  glass: {
    oscillator: { type: 'fatsine', count: 3, spread: 24 },
    envelope: { attack: 0.4, decay: 1, sustain: 0.7, release: 2.5 },
    volume: -5,
    chorus: 0.6,
  },
  choir: {
    oscillator: { type: 'fatsquare', count: 3, spread: 25 },
    envelope: { attack: 0.6, decay: 1, sustain: 0.8, release: 2.5 },
    volume: -15,
    chorus: 0.6,
  },
};

const PLUCK_PATCHES = {
  stab: {
    voice: 'Synth',
    options: {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 20 },
      envelope: { attack: 0.002, decay: 0.2, sustain: 0.15, release: 0.12 },
    },
    volume: -5,
    cutoff: 5200,
  },
  pluck: {
    voice: 'Synth',
    options: {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.3 },
    },
    volume: -4,
    cutoff: 3200,
  },
  bell: {
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
};

function makeBass(kind) {
  switch (kind) {
    case 'saw':
      return new Tone.MonoSynth({
        oscillator: { type: 'sawtooth' },
        filter: { Q: 2, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.004, decay: 0.2, sustain: 0.7, release: 0.06 },
        filterEnvelope: { attack: 0.002, decay: 0.18, sustain: 0.25, release: 0.1, baseFrequency: 90, octaves: 3.2 },
        volume: -13,
      });
    case '808':
      return new Tone.MembraneSynth({
        pitchDecay: 0.06,
        octaves: 1.8,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.4, sustain: 0.5, release: 0.3 },
        volume: -10,
      });
    case 'round':
      return new Tone.MonoSynth({
        oscillator: { type: 'square' },
        filter: { Q: 1, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.01, decay: 0.3, sustain: 0.7, release: 0.2 },
        filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.3, release: 0.2, baseFrequency: 110, octaves: 2 },
        volume: -14,
      });
    default: // 'sub'
      return new Tone.MonoSynth({
        oscillator: { type: 'triangle' },
        filter: { Q: 0.5, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.03, decay: 0.3, sustain: 0.9, release: 0.5 },
        filterEnvelope: { attack: 0.01, decay: 0.5, sustain: 1, release: 0.5, baseFrequency: 420, octaves: 0 },
        volume: -11,
      });
  }
}

const dbToGain = (db) => 10 ** (db / 20);

// Plays the recorded word at any pitch. Each note is its own one-shot
// buffer source (like Tone.Sampler), but with a fractional root note, slice
// offsets and a reversed copy for swells.
class VoxSampler {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.forward = null;
    this.backward = null;
    this.root = 60;
    this.active = new Set();
  }

  load(samples, sampleRate, rootMidi) {
    const make = (data) => {
      const buf = this.ctx.createBuffer(1, data.length, sampleRate);
      buf.copyToChannel(data, 0);
      return new Tone.ToneAudioBuffer(buf);
    };
    this.forward = make(samples);
    this.backward = make(Float32Array.from(samples).reverse());
    this.root = rootMidi;
  }

  get duration() {
    return this.forward ? this.forward.duration : 0;
  }

  rate(midi) {
    return 2 ** ((midi - this.root) / 12);
  }

  trigger(midi, time, duration, velocity = 1, { offset = 0, reverse = false, release = 0.05 } = {}) {
    const buffer = reverse ? this.backward : this.forward;
    if (!buffer) return;
    const rate = this.rate(midi);
    const start = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.05));
    const available = (buffer.duration - start) / rate;
    const length = Math.max(0.03, Math.min(duration, available));
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
    this.instruments = [];
    this.lastHit = new Map();
    this.playing = false;
    this.onSection = null;
    this.onVoxNote = null;
    this.onEnd = null;

    // --- master -----------------------------------------------------------
    // Web Audio compressors add their own makeup gain, so the "limiter"
    // still overshoots a little; the trim after it keeps peaks under 0 dB.
    this.trim = new Tone.Gain(dbToGain(-2)).toDestination();
    this.limiter = new Tone.Limiter(-1).connect(this.trim);
    this.glue = new Tone.Compressor({ threshold: -14, ratio: 2.5, attack: 0.02, release: 0.25 }).connect(this.limiter);
    this.master = new Tone.Gain(1).connect(this.glue);
    if (!offline) {
      this.analyser = new Tone.Waveform(512);
      this.trim.connect(this.analyser);
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
    this.ready = this.reverb.ready;

    const bus = (rev, dly) => {
      const input = new Tone.Gain(1).connect(this.master);
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

    // --- vocal chops --------------------------------------------------------
    this.voxIn = new Tone.Gain(1);
    this.voxHighpass = new Tone.Filter({ type: 'highpass', frequency: 130 });
    this.voxComp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.005, release: 0.12 });
    this.voxLevel = new Tone.Gain(dbToGain(-3));
    this.voxIn.chain(this.voxHighpass, this.voxComp, this.voxLevel, this.buses.vox.input);
    this.sampler = new VoxSampler(this.ctx, this.voxIn);

    // --- pad / keys / bass chains (synths are swapped per song) ----------
    this.padFilter = new Tone.Filter({ type: 'lowpass', frequency: 1200, Q: 0.6, rolloff: -24 });
    this.padChorus = new Tone.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.6, wet: 0 });
    this.padPump = new Tone.Gain(1);
    this.padFilter.chain(this.padChorus, this.padPump, this.buses.pad.input);
    if (offline) this.padChorus.start(0);
    else this.padChorus.start();

    this.keysFilter = new Tone.Filter({ type: 'lowpass', frequency: 5000, rolloff: -12 });
    this.keysPump = new Tone.Gain(1);
    this.keysFilter.chain(this.keysPump, this.buses.keys.input);

    this.bassPump = new Tone.Gain(1).connect(this.master);

    // --- drums --------------------------------------------------------------
    const drums = this.buses.drums.input;
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

    this.snareTone = new Tone.Filter({ type: 'highpass', frequency: 900 }).connect(drums);
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
    }).connect(drums);

    this.clapTone = new Tone.Filter({ type: 'bandpass', frequency: 1400, Q: 1.1 }).connect(drums);
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
    }).connect(drums);

    this.crashFilter = new Tone.Filter({ type: 'highpass', frequency: 4500 }).connect(drums);
    this.crash = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 0.2 },
      volume: -12,
    }).connect(this.crashFilter);

    // --- risers and impacts -----------------------------------------------
    this.riserGain = new Tone.Gain(0).connect(this.buses.fx.input);
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
    }).connect(this.master);

    this.setFx(this.fx);
  }

  _decayFor(size) {
    return 1 + (size / 100) * 9;
  }

  _setParam(param, value) {
    if (this.offline || !this.playing) param.value = value;
    else param.rampTo(value, 0.08);
  }

  setFx(partial) {
    this.fx = { ...this.fx, ...partial };
    const f = this.fx;
    this._setParam(this.reverbReturn.gain, (f.reverb / 100) * 1.1);
    this._setParam(this.delayReturn.gain, (f.delay / 100) * 0.9);
    this._setParam(this.delay.feedback, (f.feedback / 100) * 0.82);
    this._setParam(this.master.gain, f.volume <= 0 ? 0 : dbToGain((f.volume - 100) * 0.25));
    const decay = this._decayFor(f.size);
    if (Math.abs(decay - Number(this.reverb.decay)) > 0.05) {
      // regenerating the impulse response is async; don't do it per pixel
      clearTimeout(this._decayTimer);
      if (this.offline) this.reverb.decay = decay;
      else this._decayTimer = setTimeout(() => (this.reverb.decay = decay), 180);
    }
  }

  setVoice(voice) {
    this.voice = voice;
    this.sampler.load(voice.samples, voice.sampleRate, voice.rootMidi);
  }

  // Swap the synths for the ones this song's style asks for.
  _buildInstruments(style) {
    for (const inst of this.instruments) inst.dispose();
    const pad = PAD_PATCHES[style.pad] ?? PAD_PATCHES.warm;
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: pad.oscillator,
      envelope: pad.envelope,
      volume: pad.volume,
    }).connect(this.padFilter);
    this.pad.maxPolyphony = 24;
    this.padChorus.wet.value = pad.chorus;

    const pluck = PLUCK_PATCHES[style.pluck] ?? PLUCK_PATCHES.pluck;
    this.keys = new Tone.PolySynth(Tone[pluck.voice], { ...pluck.options, volume: pluck.volume }).connect(this.keysFilter);
    this.keys.maxPolyphony = 24;
    this.keysFilter.frequency.value = pluck.cutoff;

    this.bass = makeBass(style.bass);
    if (style.bass === '808') {
      this.bassDrive = new Tone.Distortion(0.3).connect(this.bassPump);
      this.bass.connect(this.bassDrive);
    } else {
      this.bassDrive = null;
      this.bass.connect(this.bassPump);
    }

    const hard = style.groove === 'four' || style.groove === 'breaks' || style.groove === 'halftime';
    this.kick = new Tone.MembraneSynth({
      pitchDecay: hard ? 0.045 : 0.06,
      octaves: hard ? 7 : 5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: hard ? 0.38 : 0.5, sustain: 0, release: 0.1 },
      volume: hard ? 0 : -1,
    }).connect(this.master);
    this.kickNote = hard ? 'G1' : 'F1';

    this.instruments = [this.pad, this.keys, this.bass, this.kick, this.bassDrive].filter(Boolean);
    this.lastHit.clear();
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

  _snare(time, vel) {
    this.snareNoise.triggerAttackRelease(0.15, this._hitTime('snareNoise', time), vel);
    this.snareBody.triggerAttackRelease('G3', 0.1, this._hitTime('snareBody', time), vel * 0.8);
  }

  _clap(time, vel) {
    const t = this._hitTime('clap', time);
    this.clap.triggerAttackRelease(0.01, t, vel * 0.6);
    this.clap.triggerAttackRelease(0.01, t + 0.011, vel * 0.7);
    this.clap.triggerAttackRelease(0.06, t + 0.022, vel);
    this.lastHit.set('clap', t + 0.022);
  }

  _rim(time, vel) {
    this.rim.triggerAttackRelease('E5', 0.04, this._hitTime('rim', time), vel);
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

    const swingOffset = song.swing * this.stepSec;
    const at = (step, fn) => {
      const swing = Number.isInteger(step) && step % 2 === 1 ? swingOffset : 0;
      this.transport.schedule((time) => fn(time + swing), `${Math.round(step * this.ticksPerStep)}i`);
    };
    const sec = (steps) => steps * this.stepSec;
    const T = song.tracks;

    for (const e of T.pad) {
      const freqs = e.notes.map(midiToFreq);
      at(e.step, (t) => this.pad.triggerAttackRelease(freqs, sec(e.dur), t, e.vel));
    }
    for (const e of T.keys) {
      const freqs = e.notes.map(midiToFreq);
      at(e.step, (t) => this.keys.triggerAttackRelease(freqs, sec(e.dur), t, e.vel));
    }
    for (const e of T.bass) {
      at(e.step, (t) => this.bass.triggerAttackRelease(midiToFreq(e.note), sec(e.dur), this._hitTime('bass', t), e.vel));
    }
    for (const e of T.vox) {
      at(e.step, (t) => {
        const offset = e.offset === 'vowel' && this.voice ? this.voice.vowelOffset : 0;
        this.sampler.trigger(e.midi, t, sec(e.dur), e.vel, { offset });
        if (this.draw && this.onVoxNote) this.draw.schedule(() => this.onVoxNote(e.midi, sec(e.dur)), t);
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

    const snareHit = { clap: this._clap, rim: this._rim, snare: this._snare }[song.style.snareSound] ?? this._snare;
    for (const e of T.kick) {
      at(e.step, (t) => {
        const time = this._hitTime('kick', t);
        this.kick.triggerAttackRelease(this.kickNote, 0.3, time, e.vel);
        this._pump(time, e.pump);
      });
    }
    for (const e of T.snare) at(e.step, (t) => snareHit.call(this, t, e.vel));
    for (const e of T.roll) at(e.step, (t) => this._snare(t, e.vel));
    for (const e of T.hat) at(e.step, (t) => this.hat.triggerAttackRelease(0.03, this._hitTime('hat', t), e.vel));
    for (const e of T.ohat) at(e.step, (t) => this.ohat.triggerAttackRelease(0.1, this._hitTime('ohat', t), e.vel));
    for (const e of T.crash) at(e.step, (t) => this.crash.triggerAttackRelease(1, this._hitTime('crash', t), e.vel));

    for (const a of song.automation) {
      at(a.step, (t) => this._automate(a, t));
    }
    for (const s of song.sections) {
      at(s.startStep, (t) => {
        if (this.draw && this.onSection) this.draw.schedule(() => this.onSection(s), t);
      });
    }
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
    this._resetAutomation(time);
    this.lastHit.clear();
    // start one tick early so events sitting exactly on the start step fire
    const tick = Math.max(0, Math.round(fromStep * this.ticksPerStep) - 1);
    this.transport.start(time, `${tick}i`);
    this.playing = true;
  }

  stop() {
    this.playing = false;
    this.transport.stop(); // also cancels a start that hasn't kicked in yet
    const now = this.ctx.now();
    this.pad?.releaseAll(now);
    this.keys?.releaseAll(now);
    this.bass?.triggerRelease(now);
    this.sampler.stopAll(now);
    this.riserGain.gain.cancelScheduledValues(now);
    this.riserGain.gain.setValueAtTime(0, now);
    this.lastHit.clear();
  }

  // Current position in 16th-note steps.
  get position() {
    if (!this.isPlaying) return 0;
    return Math.max(0, this.transport.getTicksAtTime(this.ctx.immediate()) / this.ticksPerStep);
  }

  // Play the word at a pitch, right now (for the on-screen keyboard).
  audition(midi, duration = 2) {
    this.sampler.trigger(midi, this.ctx.immediate() + 0.01, duration, 0.9, { release: 0.08 });
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
export async function renderSong({ song, voice, fx, onProgress = () => {}, sampleRate = 44100 }) {
  const duration = song.durationSec + TAIL_SECONDS;
  const native = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const offline = new Tone.OfflineContext(native);
  const original = Tone.getContext();
  Tone.setContext(offline);
  try {
    const engine = new Engine({ offline: true, fx });
    await engine.ready;
    engine.setVoice(voice);
    engine.load(song);
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
