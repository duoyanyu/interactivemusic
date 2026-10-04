// UI wiring: record → mood → song → effects.

import {
  trimSilence,
  normalize,
  detectPitch,
  findVowelOffset,
  synthDemoVoice,
} from './audio-utils.js';
import { generateSong, applyVoice, MOODS, sectionAt } from './composer.js';
import { Engine, DEFAULT_FX, renderSong } from './engine.js';
import { MicRecorder, decodeToMono, micSupported } from './recorder.js';
import { randomSeed } from './rng.js';
import { freqToMidi, midiToName } from './theory.js';
import { ArrangementView, drawSample, drawLiveInput, drawScope, lcdColors } from './viz.js';
import { encodeWav } from './wav.js';

const Tone = globalThis.Tone;
const $ = (sel) => document.querySelector(sel);
const MAX_RECORD_SECONDS = 2.5;
const KEY_MAP = 'awsedftgyhujkolp;';

const state = {
  mood: 'hype',
  seed: randomSeed(),
  voice: null,
  song: null,
  fx: { ...DEFAULT_FX },
  engine: null,
  enginePromise: null,
  recorder: null,
  recording: false,
  section: null,
  exporting: false,
  kbStart: 48,
};

const el = {
  rec: $('#rec'),
  wave: $('#wave'),
  sampleLcd: $('.lcd-sample'),
  statLen: $('#stat-len'),
  statRoot: $('#stat-root'),
  statHz: $('#stat-hz'),
  sourceChip: $('#source-chip'),
  demo: $('#demo'),
  upload: $('#upload'),
  pads: [...document.querySelectorAll('.pad')],
  arrange: $('#arrange'),
  songLcd: $('.lcd-song'),
  key: $('#r-key'),
  bpm: $('#r-bpm'),
  chords: $('#r-chords'),
  roman: $('#r-roman'),
  groove: $('#r-groove'),
  section: $('#r-section'),
  time: $('#r-time'),
  play: $('#play'),
  randomize: $('#randomize'),
  export: $('#export'),
  keyboard: $('#keyboard'),
  faders: [...document.querySelectorAll('[data-fx]')],
  scope: $('#scope'),
  status: $('#status'),
};

const arrangement = new ArrangementView(el.arrange);

// ---------------------------------------------------------------------------
// status line

let statusTimer;
function say(message, tone = 'info') {
  el.status.textContent = message;
  el.status.dataset.tone = tone;
  clearTimeout(statusTimer);
  if (tone !== 'error') statusTimer = setTimeout(() => (el.status.textContent = ''), 6000);
}

// ---------------------------------------------------------------------------
// audio engine (created on first click, browsers block sound before that)

function ensureEngine() {
  if (state.engine) return Promise.resolve(state.engine);
  if (!Tone) {
    say("Tone.js didn't load, so there's no sound. Check your connection and reload the page.", 'error');
    return Promise.reject(new Error('Tone.js missing'));
  }
  state.enginePromise ??= (async () => {
    await Tone.start();
    const engine = new Engine({ fx: state.fx });
    await engine.ready;
    engine.onSection = (s) => {
      state.section = s.id;
      el.section.textContent = s.name;
    };
    engine.onVoxNote = (midi, seconds) => flashKey(midi, seconds);
    engine.onEnd = () => setPlaying(false);
    if (state.voice) engine.setVoice(state.voice);
    if (state.song) engine.load(state.song);
    state.engine = engine;
    return engine;
  })();
  return state.enginePromise;
}

// ---------------------------------------------------------------------------
// the word

class FriendlyError extends Error {}

function buildVoice(raw, sampleRate, source) {
  const capped = raw.length > sampleRate * 12 ? raw.subarray(0, sampleRate * 12) : raw;
  const trim = trimSilence(capped, sampleRate);
  if (trim.silent || trim.samples.length < sampleRate * 0.06) {
    throw new FriendlyError("Didn't catch a word there. Get a little closer to the mic and try again.");
  }
  const samples = normalize(trim.samples);
  const pitch = detectPitch(samples, sampleRate);
  return {
    raw: capped,
    start: trim.start,
    end: trim.end,
    samples,
    sampleRate,
    rootMidi: pitch ? freqToMidi(pitch.freq) : 60,
    freq: pitch ? pitch.freq : null,
    vowelOffset: findVowelOffset(samples, sampleRate),
    source,
  };
}

const SOURCE_LABELS = { demo: 'Demo voice', mic: 'Your recording', file: 'Uploaded clip' };

function useVoice(voice, { audition = true } = {}) {
  state.voice = voice;
  el.sourceChip.textContent = SOURCE_LABELS[voice.source];
  el.statLen.textContent = `${(voice.samples.length / voice.sampleRate).toFixed(2)}s`;
  el.statRoot.textContent = midiToName(voice.rootMidi);
  el.statHz.textContent = voice.freq ? Math.round(voice.freq) : 'n/a';
  drawSampleLcd();

  if (state.song) state.song = applyVoice(state.song, voice.rootMidi);
  buildKeyboard();
  arrangement.setSong(state.song, lcdColors(el.songLcd));
  drawArrangement();

  if (state.engine) {
    const wasPlaying = state.engine.isPlaying;
    state.engine.setVoice(voice);
    state.engine.load(state.song);
    if (wasPlaying) state.engine.play(0);
    if (audition && !wasPlaying) state.engine.audition(Math.round(voice.rootMidi), 2);
  }
  if (!voice.freq) {
    say("Couldn't hear a clear pitch in that one (whispers and hard consonants do that), so it's tuned as C4. Still works.");
  }
}

function drawSampleLcd() {
  const v = state.voice;
  drawSample(el.wave, lcdColors(el.sampleLcd), v ? { raw: v.raw, start: v.start, end: v.end } : {});
}

async function toggleRecord() {
  if (state.recording) {
    state.recorder?.stop();
    return;
  }
  if (!micSupported()) {
    say("This browser can't record here. Upload a clip or use the demo voice instead.", 'error');
    return;
  }
  let engine;
  try {
    engine = await ensureEngine();
  } catch {
    return;
  }
  if (engine.isPlaying) stopPlayback();

  const raw = Tone.getContext().rawContext;
  const recorder = new MicRecorder(raw);
  state.recorder = recorder;
  let blob;
  try {
    setRecording(true);
    blob = await recorder.start({ maxSeconds: MAX_RECORD_SECONDS });
  } catch (err) {
    setRecording(false);
    state.recorder = null;
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      say('Mic access is blocked. Allow the microphone for this page in your browser, or upload a clip instead.', 'error');
    } else if (err?.name === 'NotFoundError') {
      say('No microphone found. Plug one in, or upload a clip instead.', 'error');
    } else {
      say(`Recording failed: ${err?.message || err}`, 'error');
    }
    return;
  }
  setRecording(false);
  state.recorder = null;
  try {
    const { samples, sampleRate } = await decodeToMono(await blob.arrayBuffer(), raw);
    useVoice(buildVoice(samples, sampleRate, 'mic'));
    say('Got it. That word is now your instrument.');
  } catch (err) {
    say(err instanceof FriendlyError ? err.message : "Couldn't read that recording. Give it another go.", 'error');
  }
}

function setRecording(on) {
  state.recording = on;
  el.rec.classList.toggle('is-recording', on);
  el.rec.setAttribute('aria-pressed', String(on));
  el.rec.querySelector('.rec-label').textContent = on ? 'Stop' : 'Rec';
  if (on) startLoop();
  else drawSampleLcd();
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    say('That file is over 25 MB. Trim it to a short word first.', 'error');
    return;
  }
  try {
    const ctx = Tone ? Tone.getContext().rawContext : new AudioContext();
    const { samples, sampleRate } = await decodeToMono(await file.arrayBuffer(), ctx);
    useVoice(buildVoice(samples, sampleRate, 'file'), { audition: false });
    say(`Loaded "${file.name}".`);
  } catch (err) {
    say(err instanceof FriendlyError ? err.message : "Couldn't decode that file. Try a WAV, MP3 or M4A.", 'error');
  }
}

function useDemoVoice({ audition = true } = {}) {
  const sampleRate = 44100;
  useVoice(buildVoice(synthDemoVoice(sampleRate), sampleRate, 'demo'), { audition });
}

// ---------------------------------------------------------------------------
// song

function newSong({ mood = state.mood, seed = randomSeed(), applyFx = true } = {}) {
  state.mood = mood;
  state.seed = seed;
  const wasPlaying = state.engine?.isPlaying;
  state.song = generateSong({ mood, seed, voiceRoot: state.voice ? state.voice.rootMidi : 60 });
  document.documentElement.dataset.mood = mood;
  el.pads.forEach((p) => p.setAttribute('aria-checked', String(p.dataset.mood === mood)));
  drawSampleLcd(); // the screens take the mood's colour
  if (applyFx) setFx({ ...state.fx, ...state.song.fx });

  const s = state.song;
  el.key.textContent = s.key;
  el.bpm.textContent = s.bpm;
  el.chords.textContent = s.chords.map((c) => c.symbol).join('  ');
  el.roman.textContent = s.progression;
  el.groove.textContent = s.style.grooveName;
  el.section.textContent = '–';
  state.section = null;
  updateTime(0);
  buildKeyboard();
  arrangement.setSong(s, lcdColors(el.songLcd));
  drawArrangement();

  if (state.engine) {
    state.engine.load(s);
    if (wasPlaying) {
      state.engine.play(0);
      startLoop();
    } else {
      setPlaying(false);
    }
  }
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateTime(step) {
  const s = state.song;
  el.time.textContent = `${formatTime(step * s.stepSec)} / ${formatTime(s.durationSec)}`;
}

async function togglePlay() {
  let engine;
  try {
    engine = await ensureEngine();
  } catch {
    return;
  }
  if (engine.isPlaying) stopPlayback();
  else startPlayback(0);
}

async function startPlayback(fromStep) {
  const engine = await ensureEngine();
  if (state.recording) return;
  engine.play(fromStep);
  const sec = sectionAt(state.song, fromStep);
  if (sec) {
    state.section = sec.id;
    el.section.textContent = sec.name;
  }
  setPlaying(true);
}

function stopPlayback() {
  state.engine?.stop();
  setPlaying(false);
}

function setPlaying(on) {
  el.play.textContent = on ? 'Stop' : 'Play';
  el.play.setAttribute('aria-pressed', String(on));
  document.documentElement.classList.toggle('is-playing', on);
  if (on) startLoop();
  else {
    state.section = null;
    el.section.textContent = '–';
    updateTime(0);
    drawArrangement();
  }
}

async function exportWav() {
  if (state.exporting || !state.song || !state.voice) return;
  state.exporting = true;
  el.export.disabled = true;
  const label = el.export.textContent;
  el.export.textContent = 'Rendering 0%';
  try {
    const buffer = await renderSong({
      song: state.song,
      voice: state.voice,
      fx: state.fx,
      onProgress: (p) => (el.export.textContent = `Rendering ${Math.round(p * 100)}%`),
    });
    el.export.textContent = 'Saving…';
    const s = state.song;
    const name = `chop-shop-${s.mood}-${s.key.replace(/\s+/g, '-').replace('#', 's')}-${s.bpm}bpm.wav`;
    downloadBlob(encodeWav(buffer), name);
    say(`Saved ${name}.`);
  } catch (err) {
    console.error(err);
    say(`Export failed: ${err?.message || err}`, 'error');
  } finally {
    state.exporting = false;
    el.export.disabled = false;
    el.export.textContent = label;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------------------
// effects

function setFx(fx) {
  state.fx = { ...state.fx, ...fx };
  for (const input of el.faders) {
    const v = state.fx[input.dataset.fx];
    input.value = v;
    paintFader(input);
  }
  state.engine?.setFx(state.fx);
}

function paintFader(input) {
  input.style.setProperty('--fill', `${input.value}%`);
  const out = input.parentElement.querySelector('output');
  if (out) out.textContent = input.value;
}

// ---------------------------------------------------------------------------
// keyboard

function buildKeyboard() {
  const tonic = state.song ? state.song.melodyTonic : 60;
  const start = 12 * Math.floor((tonic - 3) / 12);
  const root = state.voice ? Math.round(state.voice.rootMidi) : null;
  if (start === state.kbStart && el.keyboard.childElementCount && el.keyboard.dataset.root === String(root)) return;
  state.kbStart = start;
  el.keyboard.dataset.root = String(root);
  el.keyboard.replaceChildren();
  const BLACK = [1, 3, 6, 8, 10];
  for (let i = 0; i <= 24; i++) {
    const midi = start + i;
    const key = document.createElement('button');
    key.type = 'button';
    key.className = BLACK.includes(midi % 12) ? 'key key-black' : 'key key-white';
    key.dataset.midi = midi;
    key.setAttribute('aria-label', `Play ${midiToName(midi)}`);
    if (midi === root) key.classList.add('is-root');
    const hint = KEY_MAP[i];
    key.innerHTML = `<span class="key-hint">${hint ? hint.toUpperCase() : ''}</span>${midi % 12 === 0 ? `<span class="key-name">${midiToName(midi)}</span>` : ''}`;
    el.keyboard.append(key);
  }
}

const keyTimers = new Map();
function flashKey(midi, seconds = 0.2) {
  const key = el.keyboard.querySelector(`[data-midi="${Math.round(midi)}"]`);
  if (!key) return;
  key.classList.add('is-on');
  clearTimeout(keyTimers.get(key));
  keyTimers.set(key, setTimeout(() => key.classList.remove('is-on'), Math.max(90, seconds * 1000)));
}

async function playKey(midi) {
  if (!state.voice) return;
  const engine = await ensureEngine();
  engine.audition(midi, 2.5);
  flashKey(midi, 0.25);
}

// ---------------------------------------------------------------------------
// drawing loop (runs while playing or recording)

let looping = false;
const scopeColors = () => lcdColors(el.scope.parentElement);
const liveBuffer = new Float32Array(1024);

function startLoop() {
  if (looping) return;
  looping = true;
  requestAnimationFrame(loop);
}

function loop() {
  const recording = state.recording;
  const playing = state.engine?.isPlaying;
  if (recording) {
    const elapsed = state.recorder.elapsed();
    drawLiveInput(el.wave, lcdColors(el.sampleLcd), state.recorder.readWaveform(liveBuffer), elapsed / MAX_RECORD_SECONDS);
    let level = 0;
    for (const v of liveBuffer) level = Math.max(level, Math.abs(v));
    el.rec.style.setProperty('--level', Math.min(1, level * 2.5).toFixed(2));
    el.statLen.textContent = `${Math.max(0, MAX_RECORD_SECONDS - elapsed).toFixed(1)}s`;
  }
  if (playing) {
    const pos = state.engine.position;
    arrangement.frame(pos, state.section);
    updateTime(Math.min(pos, state.song.totalSteps));
    drawScope(el.scope, scopeColors(), state.engine.analyser.getValue());
  }
  if (recording || playing) requestAnimationFrame(loop);
  else {
    looping = false;
    drawScope(el.scope, scopeColors(), null);
    el.rec.style.setProperty('--level', 0);
  }
}

function drawArrangement() {
  arrangement.frame(state.engine?.isPlaying ? state.engine.position : 0, state.section);
}

function redrawAll() {
  drawSampleLcd();
  arrangement.setSong(state.song, lcdColors(el.songLcd));
  drawArrangement();
  drawScope(el.scope, scopeColors(), null);
}

// ---------------------------------------------------------------------------
// events

el.rec.addEventListener('click', toggleRecord);
el.demo.addEventListener('click', () => {
  useDemoVoice();
  say('Demo voice loaded.');
});
el.upload.addEventListener('change', () => {
  loadFile(el.upload.files[0]);
  el.upload.value = '';
});

el.pads.forEach((pad) =>
  pad.addEventListener('click', () => {
    ensureEngine().catch(() => {});
    newSong({ mood: pad.dataset.mood });
  }),
);
el.play.addEventListener('click', togglePlay);
el.randomize.addEventListener('click', () => {
  el.randomize.classList.remove('is-rolling');
  void el.randomize.offsetWidth; // restart the dice animation
  el.randomize.classList.add('is-rolling');
  newSong({ mood: state.mood });
});
el.export?.addEventListener('click', exportWav);

el.arrange.addEventListener('click', (e) => {
  const rect = el.arrange.getBoundingClientRect();
  const section = arrangement.sectionAtX(e.clientX - rect.left);
  if (section) startPlayback(section.startStep);
});

for (const input of el.faders) {
  input.addEventListener('input', () => {
    paintFader(input);
    state.fx[input.dataset.fx] = Number(input.value);
    state.engine?.setFx({ [input.dataset.fx]: Number(input.value) });
  });
}

el.keyboard.addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.key');
  if (!key) return;
  e.preventDefault();
  playKey(Number(key.dataset.midi));
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
  if (e.code === 'Space') {
    if (typing || target.closest?.('button, label')) return;
    e.preventDefault();
    togglePlay();
    return;
  }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (k === 'r') {
    toggleRecord();
    return;
  }
  const i = KEY_MAP.indexOf(k);
  if (i >= 0) playKey(state.kbStart + i);
});

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawAll, 60);
}).observe(document.body);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);
new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------------------------------------------------------------------------
// start in a playable state: demo voice + a hype track ready to go

if (!micSupported()) {
  el.rec.disabled = true;
  $('#sample-hint').textContent =
    "The mic isn't available on this page, so upload a short voice memo of one word (or keep the demo voice).";
}
useDemoVoice({ audition: false });
newSong({ mood: state.mood, seed: state.seed });
if (document.fonts?.ready) document.fonts.ready.then(redrawAll);

// handy for poking at things from the console
window.chopShop = { state, newSong, MOODS };
