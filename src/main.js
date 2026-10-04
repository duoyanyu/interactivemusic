// UI wiring: record → chop → mood → song → visuals, plus the studio,
// sound slots, mixer, stage mode and exhibit mode.

import { trimSilence, normalize, detectPitch, findVowelOffset, synthDemoVoice } from './audio-utils.js';
import {
  buildSong,
  rollRecipe,
  applyVoice,
  MOODS,
  MOOD_IDS,
  GROOVES,
  CHOP_MODES,
  DENSITIES,
  FORMS,
  progressionsFor,
  describeProgression,
  encodeRecipe,
  decodeRecipe,
  sectionAt,
} from './composer.js';
import { KEYS_STYLES } from './moods.js';
import { BASS_PATCHES, KITS, PAD_PATCHES, PLUCK_PATCHES, TEXTURES } from './patches.js';
import { Engine, DEFAULT_FX, DEFAULT_MIX, MIX_CHANNELS, SLOTS, renderSong } from './engine.js';
import { MicRecorder, decodeToMono, micSupported } from './recorder.js';
import { randomSeed } from './rng.js';
import {
  CHORD_TYPES,
  chordForRoot,
  degreeOf,
  freqToMidi,
  midiToName,
  mod,
  pcName,
  recognizeChord,
  romanNumeral,
  SCALES,
  SCALE_LABELS,
} from './theory.js';
import { ArrangementView, drawSample, drawLiveInput, drawScope, lcdColors } from './viz.js';
import { Visualizer, SCENES } from './visualizer.js';
import { detectSlices, evenSlices, cutSlice } from './slicer.js';
import { encodeWav } from './wav.js';

const Tone = globalThis.Tone;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const MAX_RECORD_SECONDS = 3;
const SLOT_RECORD_SECONDS = 1.5;
const KEY_MAP = 'awsedftgyhujkolp;';
const EXHIBIT_IDLE_MS = 60000;

const state = {
  recipe: null,
  song: null,
  voice: null,
  fx: { ...DEFAULT_FX },
  mix: { ...DEFAULT_MIX },
  mutes: {},
  locks: new Set(),
  sliceMode: 'auto',
  slots: {},
  engine: null,
  enginePromise: null,
  recorder: null,
  recording: false,
  recordTarget: null,
  section: null,
  exporting: false,
  kbStart: 48,
  scene: 'auto',
  word: '',
  stage: false,
  exhibit: false,
  exhibitScreen: 'attract',
  kbOctave: 0, // octave shift from the buttons
  keyMode: 'word',
  liveType: 'diatonic',
  held: new Map(), // midi -> where it came from ('screen' | 'kbd' | 'midi')
  midi: null,
};

const el = {
  rec: $('#rec'),
  wave: $('#wave'),
  sampleLcd: $('.lcd-sample'),
  statLen: $('#stat-len'),
  statRoot: $('#stat-root'),
  statHz: $('#stat-hz'),
  statSlices: $('#stat-slices'),
  sourceChip: $('#source-chip'),
  sliceModes: $$('#slice-modes [data-slices]'),
  demo: $('#demo'),
  upload: $('#upload'),
  moodPads: $('#mood-pads'),
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
  topPlay: $('#top-play'),
  dockPlay: $('#dock-play'),
  dockRec: $('#dock-rec'),
  dockSection: $('#dock-section'),
  dockTime: $('#dock-time'),
  randomize: $('#randomize'),
  newMelody: $('#new-melody'),
  export: $('#export'),
  keyboard: $('#keyboard'),
  faders: $$('[data-fx]'),
  mixer: $('#mixer'),
  slots: $('#slots'),
  scope: $('#scope'),
  status: $('#status'),
  stage: $('#stage'),
  stageCanvas: $('#stage-canvas'),
  scenes: $('#scenes'),
  stageWord: $('#stage-word'),
  orbit: $('#orbit'),
  stageOpen: $('#stage-open'),
  stageExit: $('#stage-exit'),
  hudWord: $('#hud-word'),
  hudInfo: $('#hud-info'),
  hudPlay: $('#hud-play'),
  hudRandom: $('#hud-random'),
  xy: $('#xy'),
  songCode: $('#song-code'),
  exhibit: $('#exhibit'),
  exhibitStage: $('#exhibit-stage'),
};

const arrangement = new ArrangementView(el.arrange);
let visualizer = null;
try {
  visualizer = new Visualizer(el.stageCanvas);
} catch (err) {
  console.error('Visualizer failed to start', err);
}

// ---------------------------------------------------------------------------
// phones and tablets

const isTouch = window.matchMedia('(pointer: coarse)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSmall = () => window.matchMedia('(max-width: 700px)').matches;

// A tap of vibration on Android when you hit a pad (iOS ignores it).
function buzz() {
  if (isTouch) navigator.vibrate?.(8);
}

// iPhones mute Web Audio when the ring/silent switch is on, unless a normal
// <audio> element is playing. A looping silent clip moves the page into the
// "playback" audio session so the song is heard either way.
let silentAudio = null;
function unlockIOSAudio() {
  if (!isIOS) return;
  if (!silentAudio) {
    const n = 4410;
    const fake = { numberOfChannels: 1, sampleRate: 44100, length: n, getChannelData: () => new Float32Array(n) };
    silentAudio = new Audio(URL.createObjectURL(encodeWav(fake)));
    silentAudio.loop = true;
    silentAudio.setAttribute('playsinline', '');
  }
  silentAudio.play().catch(() => {});
}

// Phones suspend audio when you switch apps or take a call; pick it back up
// on the next touch or when the page comes back.
function resumeAudio() {
  const ctx = Tone?.getContext();
  if (ctx && state.engine && ctx.state !== 'running') ctx.resume().catch(() => {});
}

// Keep the screen on while music plays (and in exhibit mode).
let wakeLock = null;
async function updateWakeLock() {
  const want = (state.engine?.isPlaying || state.exhibit) && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // not allowed here (low battery, iframe); the screen just dims
  }
}

// ---------------------------------------------------------------------------
// status line

let statusTimer;
function say(message, tone = 'info') {
  el.status.textContent = message;
  el.status.dataset.tone = tone;
  clearTimeout(statusTimer);
  if (tone !== 'error') statusTimer = setTimeout(() => (el.status.textContent = ''), 6000);
  const hint = $('#ex-hint');
  if (state.exhibit && tone === 'error' && hint) hint.textContent = message;
}

// ---------------------------------------------------------------------------
// theme + mood colours

function isLightTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === 'light';
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

function applyMoodColors() {
  const light = isLightTheme();
  const mood = MOODS[state.recipe?.mood] ?? MOODS.hype;
  document.documentElement.style.setProperty('--accent', light ? mood.colors.light : mood.colors.dark);
  for (const pad of $$('.pad, .exhibit-mood')) {
    const m = MOODS[pad.dataset.mood];
    if (m) pad.style.setProperty('--pad', light ? m.colors.light : m.colors.dark);
  }
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
    const engine = new Engine({ fx: state.fx, lite: isTouch && isSmall() });
    await engine.ready;
    engine.onEvent = onEngineEvent;
    engine.onEnd = onSongEnd;
    engine.setMix(state.mix, state.mutes);
    for (const [name, slot] of Object.entries(state.slots)) {
      if (slot?.sound) engine.setSlot(name, slot.sound, { tune: slot.tune });
    }
    if (state.voice) engine.setVoice(state.voice);
    if (state.song) engine.load(state.song);
    engine.setOrbit(el.orbit.checked);
    visualizer?.setAnalysers({ fft: engine.fft, waveform: engine.analyser });
    state.engine = engine;
    return engine;
  })();
  state.enginePromise.catch(() => (state.enginePromise = null));
  return state.enginePromise;
}

function onEngineEvent(type, data) {
  visualizer?.event(type, data);
  if (type === 'section') {
    state.section = data.id;
    el.section.textContent = data.name;
    el.dockSection.textContent = data.name;
    updateHud();
  } else if (type === 'vox') {
    flashKey(data.midi, data.dur);
    if (data.slice !== undefined && data.slice !== null) flashJam(data.slice);
  }
}

// ---------------------------------------------------------------------------
// the word

class FriendlyError extends Error {}

function computeSlices(samples, sampleRate) {
  if (state.sliceMode === 'auto') {
    const found = detectSlices(samples, sampleRate, { maxSlices: 8 });
    // a single held vowel has nothing to chop, so fall back to even quarters
    return found.length > 1 ? found : evenSlices(samples.length, samples.length / sampleRate > 0.35 ? 4 : 2);
  }
  return evenSlices(samples.length, Number(state.sliceMode));
}

function buildVoice(raw, sampleRate, source) {
  const capped = raw.length > sampleRate * 12 ? raw.subarray(0, sampleRate * 12) : raw;
  const trim = trimSilence(capped, sampleRate, { maxLength: MAX_RECORD_SECONDS });
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
    slices: computeSlices(samples, sampleRate),
    source,
  };
}

const SOURCE_LABELS = { demo: 'Demo voice', mic: 'Your recording', file: 'Uploaded clip' };

function renderVoiceStats() {
  const voice = state.voice;
  if (!voice) return;
  el.sourceChip.textContent = SOURCE_LABELS[voice.source];
  el.statLen.textContent = `${(voice.samples.length / voice.sampleRate).toFixed(2)}s`;
  el.statRoot.textContent = midiToName(voice.rootMidi);
  el.statHz.textContent = voice.freq ? Math.round(voice.freq) : 'n/a';
  el.statSlices.textContent = voice.slices.length;
}

function useVoice(voice, { audition = true } = {}) {
  state.voice = voice;
  renderVoiceStats();
  drawSampleLcd();
  buildJamPads();
  refreshSliceOptions();

  if (state.song) state.song = applyVoice(state.song, voice.rootMidi);
  buildKeyboard();
  refreshArrangement();

  if (state.engine) {
    const wasPlaying = state.engine.isPlaying;
    const pos = state.engine.position;
    state.engine.setVoice(voice);
    state.engine.load(state.song);
    if (wasPlaying) state.engine.play(resumeStep(pos));
    if (audition && !wasPlaying) state.engine.audition(Math.round(voice.rootMidi), 2);
  }
  if (!voice.freq && voice.source !== 'demo') {
    say("Couldn't hear a clear pitch in that one (whispers and hard consonants do that), so it's tuned as C4. Still works.");
  }
}

function resliceVoice() {
  if (!state.voice) return;
  state.voice = { ...state.voice, slices: computeSlices(state.voice.samples, state.voice.sampleRate) };
  el.statSlices.textContent = state.voice.slices.length;
  state.engine?.setVoice(state.voice);
  drawSampleLcd();
  buildJamPads();
  refreshSliceOptions();
}

function drawSampleLcd() {
  const v = state.voice;
  drawSample(el.wave, lcdColors(el.sampleLcd), v ? { raw: v.raw, start: v.start, end: v.end, slices: v.slices } : {});
}

async function startRecording(target) {
  if (state.recording) {
    state.recorder?.stop();
    return null;
  }
  if (!micSupported()) {
    say("The mic isn't available here. Upload a clip instead.", 'error');
    return null;
  }
  let engine;
  try {
    engine = await ensureEngine();
  } catch {
    return null;
  }
  if (engine.isPlaying && target === 'voice') stopPlayback();

  const raw = Tone.getContext().rawContext;
  const recorder = new MicRecorder(raw);
  state.recorder = recorder;
  state.recordTarget = target;
  let blob;
  try {
    setRecording(true);
    blob = await recorder.start({ maxSeconds: target === 'voice' ? MAX_RECORD_SECONDS : SLOT_RECORD_SECONDS });
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
    return null;
  }
  setRecording(false);
  state.recorder = null;
  try {
    return await decodeToMono(await blob.arrayBuffer(), raw);
  } catch {
    say("Couldn't read that recording. Give it another go.", 'error');
    return null;
  }
}

async function recordWord() {
  const audio = await startRecording('voice');
  if (!audio) return false;
  try {
    const voice = buildVoice(audio.samples, audio.sampleRate, 'mic');
    useVoice(voice, { audition: state.exhibit });
    if (voice.freq) say('Got it. That word is now your instrument.');
    // skip the intro so the hook arrives quickly
    if (!state.exhibit && !state.engine?.isPlaying) startPlayback(buildStart());
    return true;
  } catch (err) {
    say(err instanceof FriendlyError ? err.message : "Couldn't read that recording. Give it another go.", 'error');
    return false;
  }
}

function setRecording(on) {
  state.recording = on;
  const target = state.recordTarget;
  if (target === 'voice') {
    el.dockRec.classList.toggle('is-recording', on);
    el.dockRec.setAttribute('aria-label', on ? 'Stop recording' : 'Record a word');
    el.rec.classList.toggle('is-recording', on);
    el.rec.setAttribute('aria-pressed', String(on));
    el.rec.querySelector('.rec-label').textContent = on ? 'Stop' : 'Rec';
    const exRec = $('#ex-rec');
    exRec.classList.toggle('is-recording', on);
    $('#ex-rec-label').textContent = on ? 'Listening… tap to stop' : 'Tap and speak';
  } else if (target) {
    const btn = $(`.slot[data-slot="${target}"] .slot-rec`);
    btn?.classList.toggle('is-recording', on);
    if (btn) btn.textContent = on ? 'Stop' : 'Rec';
  }
  if (on) startLoop();
  else {
    renderVoiceStats();
    drawSampleLcd();
    drawSlots();
  }
}

async function loadFile(file, target = 'voice') {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    say('That file is over 25 MB. Trim it down first.', 'error');
    return;
  }
  try {
    const ctx = Tone ? Tone.getContext().rawContext : new AudioContext();
    const { samples, sampleRate } = await decodeToMono(await file.arrayBuffer(), ctx);
    if (target === 'voice') {
      useVoice(buildVoice(samples, sampleRate, 'file'), { audition: false });
    } else {
      setSlotSound(target, samples, sampleRate, 'Clip');
    }
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
// jam pads: slices of the word, playable live (keys 1-8)

const jamContainers = () => [$('#jam-pads'), $('#hud-jam'), $('#ex-jam')].filter(Boolean);

function buildJamPads() {
  const n = state.voice ? Math.min(8, state.voice.slices.length) : 0;
  for (const box of jamContainers()) {
    box.replaceChildren();
    for (let i = 0; i < n; i++) {
      const pad = document.createElement('button');
      pad.type = 'button';
      pad.className = 'jam-pad';
      pad.dataset.slice = i;
      pad.textContent = i + 1;
      pad.setAttribute('aria-label', `Play slice ${i + 1}`);
      box.append(pad);
    }
  }
}

const jamTimers = new Map();
function flashJam(slice) {
  const n = state.voice?.slices.length || 1;
  const i = ((slice % n) + n) % n;
  for (const pad of $$(`.jam-pad[data-slice="${i}"]`)) {
    pad.classList.add('is-on');
    clearTimeout(jamTimers.get(pad));
    jamTimers.set(pad, setTimeout(() => pad.classList.remove('is-on'), 140));
  }
}

async function playJam(i) {
  if (!state.voice) return;
  buzz();
  const engine = await ensureEngine();
  engine.jamSlice(i);
  flashJam(i);
  touchExhibit();
}

// ---------------------------------------------------------------------------
// recipe → song

function buildStart() {
  return state.song?.sections.find((s) => s.id === 'build')?.startStep ?? 0;
}

function resumeStep(pos) {
  if (!state.song) return 0;
  const bar = Math.floor(pos / 16) * 16;
  return Math.max(0, Math.min(bar, state.song.totalSteps - 16));
}

// Rebuild the song from the current recipe; keeps playing from the same bar.
function rebuild({ restart = false } = {}) {
  const engine = state.engine;
  const wasPlaying = engine?.isPlaying;
  const pos = wasPlaying ? engine.position : 0;
  state.song = buildSong(state.recipe, state.voice ? state.voice.rootMidi : 60);
  renderSongInfo();
  if (engine) {
    engine.load(state.song);
    if (wasPlaying) {
      engine.play(restart ? 0 : resumeStep(pos));
      startLoop();
    } else {
      setPlaying(false);
    }
  }
  el.songCode.value = encodeRecipe(state.recipe);
}

function setRecipe(recipe, { restart = true } = {}) {
  state.recipe = recipe;
  document.documentElement.dataset.mood = recipe.mood;
  for (const p of $$('.pad')) p.setAttribute('aria-checked', String(p.dataset.mood === recipe.mood));
  applyMoodColors();
  setFx({ ...state.fx, ...recipe.fx }, { syncRecipe: false });
  syncStudio();
  rebuild({ restart });
  visualizer?.setMood(recipe.mood);
  visualizer?.refreshColors();
  drawSampleLcd();
  drawSlots();
}

function newSong(mood = state.recipe?.mood ?? 'hype', { restart = false } = {}) {
  const recipe = rollRecipe(mood, randomSeed(), { keep: state.recipe, locks: [...state.locks] });
  setRecipe(recipe, { restart });
}

function renderSongInfo() {
  const s = state.song;
  el.key.textContent = s.key;
  el.bpm.textContent = s.bpm;
  el.chords.textContent = s.chords.slice(0, 4).map((c) => c.symbol).join('  ');
  el.roman.textContent = s.progression;
  el.groove.textContent = s.style.grooveName;
  if (!state.engine?.isPlaying) {
    el.section.textContent = '–';
    state.section = null;
  }
  updateTime(0);
  buildKeyboard();
  refreshArrangement();
  visualizer?.setSong(s);
  updateHud();
}

function refreshArrangement() {
  if (!state.song) return;
  arrangement.setSong(state.song, lcdColors(el.songLcd));
  drawArrangement();
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateTime(step) {
  const s = state.song;
  if (!s) return;
  el.time.textContent = `${formatTime(step * s.stepSec)} / ${formatTime(s.durationSec)}`;
  el.dockTime.textContent = el.time.textContent;
}

function updateHud() {
  const s = state.song;
  if (!s) return;
  const word = state.word || (state.voice?.source === 'demo' ? 'demo voice' : 'your word');
  el.hudWord.textContent = word;
  const section = s.sections.find((x) => x.id === state.section);
  const info = `${MOODS[s.mood].label} · ${s.key} · ${s.bpm} BPM${section ? ` · ${section.name}` : ''}`;
  el.hudInfo.textContent = info;
  const exInfo = $('#ex-info');
  if (exInfo) exInfo.textContent = info;
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
  if (el.status.dataset.tone === 'error') say('');
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
  for (const b of [el.play, el.hudPlay, el.topPlay, el.dockPlay]) {
    b.textContent = on ? 'Stop' : 'Play';
    b.setAttribute('aria-pressed', String(on));
  }
  document.documentElement.classList.toggle('is-playing', on);
  visualizer?.setPlaying(on);
  updateWakeLock();
  if (on) startLoop();
  else {
    state.section = null;
    el.section.textContent = '–';
    el.dockSection.textContent = 'Ready';
    updateTime(0);
    drawArrangement();
    updateHud();
  }
}

function onSongEnd() {
  setPlaying(false);
  if (state.exhibit && state.exhibitScreen === 'show') {
    setTimeout(() => state.exhibit && state.exhibitScreen === 'show' && resetExhibit(), 2500);
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
      mix: state.mix,
      mutes: state.mutes,
      slots: state.slots,
      orbit: el.orbit.checked,
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
// mood pads

function buildMoodPads() {
  el.moodPads.replaceChildren();
  const ex = $('#ex-moods');
  ex.replaceChildren();
  for (const id of MOOD_IDS) {
    const m = MOODS[id];
    const pad = document.createElement('button');
    pad.type = 'button';
    pad.className = 'pad';
    pad.dataset.mood = id;
    pad.setAttribute('role', 'radio');
    pad.setAttribute('aria-checked', 'false');
    pad.innerHTML = '<span class="pad-led" aria-hidden="true"></span><span class="pad-name"></span><span class="pad-desc"></span>';
    pad.querySelector('.pad-name').textContent = m.label;
    pad.querySelector('.pad-desc').textContent = m.blurb;
    el.moodPads.append(pad);

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'exhibit-mood';
    tile.dataset.mood = id;
    tile.textContent = m.label;
    ex.append(tile);
  }
}

// ---------------------------------------------------------------------------
// studio panel

const studio = {
  key: $('#st-key'),
  scale: $('#st-scale'),
  chords: $('#st-chords'),
  color: $('#st-color'),
  bpm: $('#st-bpm'),
  bpmOut: $('#st-bpm-out'),
  groove: $('#st-groove'),
  kit: $('#st-kit'),
  swing: $('#st-swing'),
  swingOut: $('#st-swing-out'),
  pump: $('#st-pump'),
  pumpOut: $('#st-pump-out'),
  pad: $('#st-pad'),
  pluck: $('#st-pluck'),
  keys: $('#st-keys'),
  bass: $('#st-bass'),
  texture: $('#st-texture'),
  chopMode: $('#st-chop-mode'),
  pitch: $('#st-pitch'),
  density: $('#st-density'),
  start: $('#st-start'),
  gate: $('#st-gate'),
  gateOut: $('#st-gate-out'),
  stutter: $('#st-stutter'),
  harmony: $('#st-harmony'),
  octave: $('#st-octave'),
  bars: $$('[data-bars]'),
  form: $('#st-form'),
};

function fillSelect(select, entries) {
  select.replaceChildren(
    ...entries.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }),
  );
}

function buildStudio() {
  fillSelect(studio.key, Array.from({ length: 12 }, (_, pc) => [pc, pcName(pc) === pcName(pc, true) ? pcName(pc) : `${pcName(pc)} / ${pcName(pc, true)}`]));
  fillSelect(studio.scale, Object.keys(SCALES).map((s) => [s, SCALE_LABELS[s] ?? s]));
  fillSelect(studio.groove, Object.entries(GROOVES).map(([id, g]) => [id, `${g.name} (${g.bpm[0]}–${g.bpm[1]})`]));
  fillSelect(studio.kit, Object.entries(KITS).map(([id, k]) => [id, k.label]));
  fillSelect(studio.pad, Object.entries(PAD_PATCHES).map(([id, p]) => [id, p.label]));
  fillSelect(studio.pluck, Object.entries(PLUCK_PATCHES).map(([id, p]) => [id, p.label]));
  fillSelect(studio.keys, Object.entries(KEYS_STYLES));
  fillSelect(studio.bass, Object.entries(BASS_PATCHES).map(([id, p]) => [id, p.label]));
  fillSelect(studio.texture, Object.entries(TEXTURES));
  fillSelect(studio.chopMode, Object.entries(CHOP_MODES));
  fillSelect(studio.density, Object.entries(DENSITIES));
  fillSelect(studio.form, Object.entries(FORMS));
  for (const sel of studio.bars) fillSelect(sel, [4, 8, 12, 16, 24].map((n) => [n, `${n} bars`]));
}

function progressionLabel(prog, recipe) {
  const chords = describeProgression(recipe.tonic, recipe.mode, prog, recipe.chordSize);
  return `${chords.map((c) => c.symbol).join(' – ')}   (${chords.map((c) => c.roman).join('–')})`;
}

function syncStudio() {
  const r = state.recipe;
  studio.key.value = r.tonic;
  studio.scale.value = r.mode;
  const options = progressionsFor(r.mood, r.mode);
  let index = options.findIndex((p) => p.join() === r.progression.join());
  const list = index >= 0 ? options : [...options, r.progression];
  if (index < 0) index = list.length - 1;
  fillSelect(studio.chords, list.map((p, i) => [i, progressionLabel(p, r)]));
  studio.chords.value = index;
  studio.chords.dataset.list = JSON.stringify(list);
  studio.color.value = r.chordSize;
  studio.bpm.value = r.bpm;
  studio.bpmOut.textContent = r.bpm;
  studio.groove.value = r.groove;
  studio.kit.value = r.kit;
  studio.swing.value = Math.round(r.swing * 100);
  studio.swingOut.textContent = `${Math.round(r.swing * 100)}%`;
  studio.pump.value = Math.round(r.pump * 100);
  studio.pumpOut.textContent = `${Math.round(r.pump * 100)}%`;
  studio.pad.value = r.pad;
  studio.pluck.value = r.pluck;
  studio.keys.value = r.keys;
  studio.bass.value = r.bass;
  studio.texture.value = r.texture;
  studio.chopMode.value = r.chop.mode;
  studio.pitch.value = r.chop.shift;
  studio.density.value = r.chop.density;
  studio.start.value = r.chop.start;
  studio.gate.value = Math.round(r.chop.gate * 100);
  studio.gateOut.textContent = `${Math.round(r.chop.gate * 100)}%`;
  studio.stutter.checked = r.chop.stutter;
  studio.harmony.checked = r.chop.harmony;
  studio.octave.checked = r.chop.octave;
  studio.form.value = r.form ?? 'single';
  for (const sel of studio.bars) {
    const n = r.bars[sel.dataset.bars];
    if (![...sel.options].some((o) => Number(o.value) === n)) sel.append(new Option(`${n} bars`, n));
    sel.value = n;
  }
}

// Wire a control to a recipe edit; `live` controls rebuild on release only.
function onStudio(control, apply, { event = 'change' } = {}) {
  control.addEventListener(event, () => {
    apply(state.recipe, control);
    syncStudio();
    rebuild();
  });
}

function wireStudio() {
  onStudio(studio.key, (r, c) => (r.tonic = Number(c.value)));
  onStudio(studio.scale, (r, c) => {
    r.mode = c.value;
    const options = progressionsFor(r.mood, r.mode);
    if (!options.some((p) => p.join() === r.progression.join())) r.progression = [...options[0]];
  });
  onStudio(studio.chords, (r, c) => {
    const list = JSON.parse(c.dataset.list || '[]');
    if (list[Number(c.value)]) r.progression = [...list[Number(c.value)]];
  });
  onStudio(studio.color, (r, c) => (r.chordSize = Number(c.value)));
  studio.bpm.addEventListener('input', () => (studio.bpmOut.textContent = studio.bpm.value));
  onStudio(studio.bpm, (r, c) => (r.bpm = Number(c.value)));
  onStudio(studio.groove, (r, c) => (r.groove = c.value));
  onStudio(studio.kit, (r, c) => (r.kit = c.value));
  studio.swing.addEventListener('input', () => (studio.swingOut.textContent = `${studio.swing.value}%`));
  onStudio(studio.swing, (r, c) => (r.swing = Number(c.value) / 100));
  studio.pump.addEventListener('input', () => (studio.pumpOut.textContent = `${studio.pump.value}%`));
  onStudio(studio.pump, (r, c) => (r.pump = Number(c.value) / 100));
  onStudio(studio.pad, (r, c) => (r.pad = c.value));
  onStudio(studio.pluck, (r, c) => (r.pluck = c.value));
  onStudio(studio.keys, (r, c) => (r.keys = c.value));
  onStudio(studio.bass, (r, c) => (r.bass = c.value));
  onStudio(studio.texture, (r, c) => (r.texture = c.value));
  onStudio(studio.chopMode, (r, c) => (r.chop.mode = c.value));
  onStudio(studio.pitch, (r, c) => (r.chop.shift = Number(c.value)));
  onStudio(studio.density, (r, c) => (r.chop.density = c.value));
  onStudio(studio.start, (r, c) => (r.chop.start = c.value));
  studio.gate.addEventListener('input', () => (studio.gateOut.textContent = `${studio.gate.value}%`));
  onStudio(studio.gate, (r, c) => (r.chop.gate = Number(c.value) / 100));
  onStudio(studio.stutter, (r, c) => (r.chop.stutter = c.checked));
  onStudio(studio.harmony, (r, c) => (r.chop.harmony = c.checked));
  onStudio(studio.octave, (r, c) => (r.chop.octave = c.checked));
  for (const sel of studio.bars) onStudio(sel, (r, c) => (r.bars[c.dataset.bars] = Number(c.value)));
  onStudio(studio.form, (r, c) => (r.form = c.value));

  for (const lock of $$('[data-lock]')) {
    lock.addEventListener('change', () => {
      if (lock.checked) state.locks.add(lock.dataset.lock);
      else state.locks.delete(lock.dataset.lock);
    });
  }

  $('#copy-code').addEventListener('click', async () => {
    el.songCode.select();
    try {
      await navigator.clipboard.writeText(el.songCode.value);
      say('Song code copied. Paste it into Load to bring this song back.');
    } catch {
      say('Copy blocked here. The code is selected, so copy it by hand.');
    }
  });
  $('#load-code').addEventListener('click', () => {
    const recipe = decodeRecipe(el.songCode.value);
    if (!recipe) {
      say("That song code doesn't look right. Copy the whole thing and try again.", 'error');
      return;
    }
    setRecipe(recipe);
    say('Song loaded from its code.');
  });
}

// ---------------------------------------------------------------------------
// effects + mixer

function setFx(fx, { syncRecipe = true } = {}) {
  state.fx = { ...state.fx, ...fx };
  for (const input of el.faders) {
    input.value = state.fx[input.dataset.fx];
    paintFader(input);
  }
  state.engine?.setFx(state.fx);
  if (syncRecipe && state.recipe) {
    const { volume, ...rest } = state.fx;
    state.recipe.fx = rest;
    el.songCode.value = encodeRecipe(state.recipe);
  }
}

function paintFader(input) {
  input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  const out = input.parentElement.querySelector('output');
  if (out) out.textContent = input.value;
}

function buildMixer() {
  el.mixer.replaceChildren();
  for (const [id, label] of Object.entries(MIX_CHANNELS)) {
    const row = document.createElement('div');
    row.className = 'fader fader-mix';
    row.innerHTML = `
      <label for="mix-${id}"></label>
      <input id="mix-${id}" type="range" min="0" max="100" data-mix="${id}" />
      <button type="button" class="mute" data-mute="${id}" aria-pressed="false">M</button>`;
    row.querySelector('label').textContent = label;
    row.querySelector('.mute').setAttribute('aria-label', `Mute ${label}`);
    const input = row.querySelector('input');
    input.value = state.mix[id];
    paintFader(input);
    input.addEventListener('input', () => {
      paintFader(input);
      state.mix[id] = Number(input.value);
      state.engine?.setMix(state.mix, state.mutes);
    });
    const mute = row.querySelector('.mute');
    mute.addEventListener('click', () => {
      state.mutes[id] = !state.mutes[id];
      mute.setAttribute('aria-pressed', String(state.mutes[id]));
      state.engine?.setMix(state.mix, state.mutes);
    });
    el.mixer.append(row);
  }
}

// ---------------------------------------------------------------------------
// sound slots: recorded noises (or slices of the word) as drum sounds

function buildSlots() {
  el.slots.replaceChildren();
  for (const [id, label] of Object.entries(SLOTS)) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.dataset.slot = id;
    row.innerHTML = `
      <div class="slot-head">
        <button type="button" class="slot-play" aria-label="Play ${label}"><span aria-hidden="true"></span></button>
        <strong>${label}</strong>
        <span class="slot-src">Synth</span>
      </div>
      <div class="lcd slot-lcd"><canvas aria-hidden="true"></canvas></div>
      <div class="slot-actions">
        <button type="button" class="btn btn-small slot-rec">Rec</button>
        <label class="btn btn-small">Upload<input type="file" accept="audio/*" class="visually-hidden slot-file" /></label>
        <select class="slot-slice" aria-label="Use a slice of your word as the ${label}"></select>
        <button type="button" class="btn btn-small slot-reset">Synth</button>
      </div>
      <label class="slot-tune"><span>Tune</span><input type="range" min="-12" max="12" step="1" value="0" /><output>0</output></label>`;
    el.slots.append(row);

    row.querySelector('.slot-play').addEventListener('click', async () => (await ensureEngine()).auditionSlot(id));
    row.querySelector('.slot-rec').addEventListener('click', async () => {
      const audio = await startRecording(id);
      if (audio) setSlotSound(id, audio.samples, audio.sampleRate, 'Mic');
    });
    row.querySelector('.slot-file').addEventListener('change', (e) => {
      loadFile(e.target.files[0], id);
      e.target.value = '';
    });
    row.querySelector('.slot-slice').addEventListener('change', (e) => {
      const i = e.target.value;
      if (i === '' || !state.voice) return;
      const v = state.voice;
      const slice = v.slices[Number(i)];
      if (slice) setSlotSound(id, cutSlice(v.samples, slice, v.sampleRate), v.sampleRate, `Slice ${Number(i) + 1}`, { trim: false });
      e.target.value = '';
    });
    row.querySelector('.slot-reset').addEventListener('click', () => {
      state.slots[id] = null;
      state.engine?.setSlot(id, null);
      drawSlots();
    });
    const tune = row.querySelector('.slot-tune input');
    tune.addEventListener('input', () => {
      row.querySelector('.slot-tune output').textContent = tune.value > 0 ? `+${tune.value}` : tune.value;
      if (state.slots[id]) state.slots[id].tune = Number(tune.value);
      state.engine?.setSlotTune(id, Number(tune.value));
    });
    tune.addEventListener('change', () => state.engine?.auditionSlot(id));
  }
  refreshSliceOptions();
}

function refreshSliceOptions() {
  const n = state.voice ? state.voice.slices.length : 0;
  for (const sel of $$('.slot-slice')) {
    fillSelect(sel, [['', 'Use a slice…'], ...Array.from({ length: n }, (_, i) => [i, `Slice ${i + 1}`])]);
  }
}

function setSlotSound(id, samples, sampleRate, source, { trim = true } = {}) {
  let data = samples;
  if (trim) {
    const t = trimSilence(samples, sampleRate, { maxLength: 1.2, padBefore: 0.003, padAfter: 0.03, fadeOut: 0.02 });
    if (t.silent || t.samples.length < sampleRate * 0.02) {
      say("Didn't catch a sound there. Try again a bit louder.", 'error');
      return;
    }
    data = t.samples;
  }
  const sound = { samples: normalize(data), sampleRate };
  const tune = Number($(`.slot[data-slot="${id}"] .slot-tune input`).value);
  state.slots[id] = { sound, tune, source };
  state.engine?.setSlot(id, sound, { tune });
  drawSlots();
  ensureEngine().then((e) => e.auditionSlot(id));
  say(`${SLOTS[id]} is now your sound. Hit Play to hear it in the song.`);
}

function drawSlots() {
  for (const row of $$('.slot')) {
    const id = row.dataset.slot;
    const slot = state.slots[id];
    row.querySelector('.slot-src').textContent = slot ? slot.source : 'Synth';
    row.classList.toggle('is-custom', Boolean(slot));
    const canvas = row.querySelector('canvas');
    const lcd = row.querySelector('.slot-lcd');
    if (state.recording && state.recordTarget === id) continue;
    if (slot) {
      const s = slot.sound.samples;
      drawSample(canvas, lcdColors(lcd), { raw: s, start: 0, end: s.length, compact: true });
    } else {
      drawSample(canvas, lcdColors(lcd), { label: 'SYNTH' });
    }
  }
}

// ---------------------------------------------------------------------------
// keyboard

function buildKeyboard() {
  const tonic = state.song ? state.song.melodyTonic : 60;
  const start = Math.max(24, Math.min(84, 12 * Math.floor((tonic - 3) / 12) + 12 * state.kbOctave));
  const span = isSmall() ? 12 : 24; // one octave fits a phone, two on bigger screens
  const root = state.voice ? Math.round(state.voice.rootMidi) : null;
  const sig = `${start}:${span}:${root}`;
  if (el.keyboard.dataset.sig === sig && el.keyboard.childElementCount) return;
  el.keyboard.dataset.sig = sig;
  state.kbStart = start;
  $('#oct-label').textContent = midiToName(start);
  el.keyboard.replaceChildren();
  const BLACK = [1, 3, 6, 8, 10];
  for (let i = 0; i <= span; i++) {
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

async function playKey(midi, vel = 0.9) {
  if (!state.voice) return;
  const engine = await ensureEngine();
  engine.audition(midi, 2.5);
}

// ---------------------------------------------------------------------------
// live chords: press a root (or hold a chord on a MIDI keyboard) and the
// song follows it

function setKeyMode(mode) {
  state.keyMode = mode;
  for (const c of $$('[data-keymode]')) c.setAttribute('aria-checked', String(c.dataset.keymode === mode));
  const live = mode === 'chords';
  $('#live-bar').hidden = !live;
  $('#keys-help').textContent = live
    ? "Press any key: it plays the chord that fits the song's key, and the bass, keys and chops follow you. Hold a chord on a MIDI keyboard and it reads what you play."
    : 'The dotted key is the pitch your word was recorded at. Keys light up when the song uses them.';
  state.held.clear();
  markChordKeys(null);
  if (!live) {
    $('#live-symbol').textContent = '–';
    $('#live-roman').textContent = '';
  }
  ensureEngine().then((engine) => {
    engine.setLiveMode(live);
    engine.setLoopDrop(live && $('#live-loop').checked);
  });
}

async function pressKey(midi, source = 'screen') {
  if (source === 'screen') buzz();
  if (state.keyMode !== 'chords') {
    playKey(midi);
    return;
  }
  state.held.set(midi, source);
  const engine = await ensureEngine();
  const s = state.song;
  const scale = SCALES[s.mode];
  let chord = null;
  // only trust real chords from a MIDI keyboard; computer keys overlap too easily
  const midiNotes = [...state.held].filter(([, src]) => src === 'midi').map(([n]) => n);
  if (source === 'midi' && midiNotes.length >= 2) {
    const found = recognizeChord(midiNotes, s.flats);
    if (found) chord = { rootPc: found.rootPc, pcs: found.pcs, symbol: found.symbol, degree: degreeOf(found.rootPc, s.tonicPc, scale) };
  }
  chord ??= chordForRoot(midi, s.tonicPc, s.mode, { type: state.liveType, size: s.recipe.chordSize });
  engine.liveChord(chord);
  $('#live-symbol').textContent = chord.symbol;
  $('#live-roman').textContent = chord.degree >= 0 ? romanNumeral(scale, chord.degree) : 'borrowed';
  markChordKeys(chord.pcs);
  touchExhibit();
}

function releaseKey(midi) {
  if (!state.held.delete(midi)) return;
  if (state.keyMode === 'chords' && state.held.size === 0 && !state.engine?.isPlaying) {
    state.engine?.releaseLive();
    markChordKeys(null);
  }
}

function markChordKeys(pcs) {
  for (const key of $$('.key', el.keyboard)) {
    key.classList.toggle('is-chord', Boolean(pcs?.includes(mod(Number(key.dataset.midi), 12))));
  }
}

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    say("This browser can't talk to MIDI keyboards. Chrome and Edge can.", 'error');
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    const attach = () => {
      for (const input of access.inputs.values()) input.onmidimessage = onMidiMessage;
      const names = [...access.inputs.values()].map((i) => i.name);
      $('#midi-connect').textContent = names.length ? `MIDI: ${names[0]}` : 'MIDI: waiting';
      return names;
    };
    const names = attach();
    access.onstatechange = attach;
    state.midi = access;
    say(names.length ? `Connected to ${names.join(', ')}.` : 'No MIDI keyboard found yet. Plug one in and it connects by itself.');
  } catch {
    say('MIDI access was blocked. Allow it in your browser settings to use a keyboard.', 'error');
  }
}

function onMidiMessage(e) {
  const [status, note, velocity] = e.data;
  const cmd = status & 0xf0;
  if (cmd === 0x90 && velocity > 0) {
    flashKey(note, 0.3);
    pressKey(note, 'midi');
  } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
    releaseKey(note);
  }
}

// ---------------------------------------------------------------------------
// visuals, stage mode and the XY pad

function buildScenes() {
  el.scenes.replaceChildren();
  for (const [id, label] of Object.entries(SCENES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(id === state.scene));
    b.dataset.scene = id;
    b.textContent = label;
    el.scenes.append(b);
  }
}

function setScene(id) {
  state.scene = id;
  for (const b of $$('[data-scene]')) b.setAttribute('aria-checked', String(b.dataset.scene === id));
  visualizer?.setScene(id);
}

// The stage draws its own small info line on the page; full-screen modes
// have their own controls in that corner, so it goes quiet there.
function syncVisualHud() {
  if (visualizer) visualizer.hud = !state.stage && !state.exhibit;
}

function setStage(on) {
  if (on === state.stage) return;
  state.stage = on;
  syncVisualHud();
  document.documentElement.classList.toggle('is-stage', on);
  el.stage.classList.toggle('is-stage', on);
  if (on) {
    el.stage.requestFullscreen?.().catch(() => {});
    visualizer?.start();
    updateHud();
  } else if (document.fullscreenElement === el.stage) {
    document.exitFullscreen?.().catch(() => {});
  }
  setTimeout(() => visualizer?.resize(), 50);
}

function wireXY() {
  const pad = el.xy;
  const dot = pad.querySelector('.xy-dot');
  let active = false;
  const apply = (x, y) => {
    dot.style.left = `${x * 100}%`;
    dot.style.top = `${(1 - y) * 100}%`;
    pad.setAttribute('aria-valuetext', x < 0.45 ? 'filter closing' : x > 0.55 ? 'filter thinning' : y > 0.1 ? 'echo' : 'clean');
    state.engine?.setPerformance({ x, y });
  };
  const fromEvent = (e) => {
    const r = pad.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  pad.addEventListener('pointerdown', async (e) => {
    await ensureEngine();
    active = true;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('is-active');
    apply(...fromEvent(e));
  });
  pad.addEventListener('pointermove', (e) => active && apply(...fromEvent(e)));
  const release = () => {
    if (!active) return;
    active = false;
    pad.classList.remove('is-active');
    apply(0.5, 0);
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);
  // arrow keys nudge it, Home snaps back (Escape is left to close the stage)
  let kx = 0.5;
  let ky = 0;
  pad.addEventListener('keydown', (e) => {
    const step = 0.1;
    if (e.key === 'ArrowLeft') kx = Math.max(0, kx - step);
    else if (e.key === 'ArrowRight') kx = Math.min(1, kx + step);
    else if (e.key === 'ArrowUp') ky = Math.min(1, ky + step);
    else if (e.key === 'ArrowDown') ky = Math.max(0, ky - step);
    else if (e.key === 'Home') [kx, ky] = [0.5, 0];
    else return;
    e.preventDefault();
    e.stopPropagation();
    apply(kx, ky);
  });
  apply(0.5, 0);
}

// ---------------------------------------------------------------------------
// exhibit mode: attract screen → say a word → pick a vibe → the show

let exhibitIdle;
function touchExhibit() {
  if (!state.exhibit) return;
  clearTimeout(exhibitIdle);
  if (state.exhibitScreen === 'mood') exhibitIdle = setTimeout(resetExhibit, EXHIBIT_IDLE_MS);
}

function showExhibitScreen(name) {
  state.exhibitScreen = name;
  for (const s of $$('.exhibit-screen')) s.hidden = s.dataset.screen !== name;
  el.exhibit.dataset.screen = name;
  touchExhibit();
}

function openExhibit() {
  state.exhibit = true;
  syncVisualHud();
  updateWakeLock();
  stopPlayback();
  setStage(false);
  el.exhibit.hidden = false;
  document.documentElement.classList.add('is-exhibit');
  el.exhibitStage.append(el.stageCanvas);
  visualizer?.start();
  document.documentElement.requestFullscreen?.().catch(() => {});
  resetExhibit();
  setTimeout(() => visualizer?.resize(), 50);
}

function closeExhibit() {
  state.exhibit = false;
  syncVisualHud();
  updateWakeLock();
  clearTimeout(exhibitIdle);
  stopPlayback();
  el.exhibit.hidden = true;
  document.documentElement.classList.remove('is-exhibit');
  el.stage.prepend(el.stageCanvas);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setTimeout(() => visualizer?.resize(), 50);
}

function resetExhibit() {
  stopPlayback();
  // each visitor starts fresh: drop the last person's recording
  useDemoVoice({ audition: false });
  state.word = '';
  updateHud();
  $('#ex-hint').textContent = 'You get 3 seconds. Try your name, a food, or how you feel.';
  showExhibitScreen('attract');
}

async function exhibitRecord() {
  touchExhibit();
  const ok = await recordWord();
  if (ok) showExhibitScreen('mood');
}

async function exhibitPick(mood) {
  newSong(mood);
  showExhibitScreen('show');
  await startPlayback(buildStart());
}

// ---------------------------------------------------------------------------
// drawing loop (runs while playing or recording)

let looping = false;
const liveBuffer = new Float32Array(1024);

function startLoop() {
  if (looping) return;
  looping = true;
  requestAnimationFrame(loop);
}

function loop() {
  const recording = state.recording;
  const playing = state.engine?.isPlaying;
  if (recording && state.recorder) {
    const max = state.recordTarget === 'voice' ? MAX_RECORD_SECONDS : SLOT_RECORD_SECONDS;
    const elapsed = state.recorder.elapsed();
    const data = state.recorder.readWaveform(liveBuffer);
    const target = state.recordTarget === 'voice' ? [el.wave, el.sampleLcd] : (() => {
      const row = $(`.slot[data-slot="${state.recordTarget}"]`);
      return [row.querySelector('canvas'), row.querySelector('.slot-lcd')];
    })();
    drawLiveInput(target[0], lcdColors(target[1]), data, elapsed / max);
    let level = 0;
    for (const v of data) level = Math.max(level, Math.abs(v));
    el.rec.style.setProperty('--level', Math.min(1, level * 2.5).toFixed(2));
    $('#ex-rec').style.setProperty('--level', Math.min(1, level * 2.5).toFixed(2));
    if (state.recordTarget === 'voice') el.statLen.textContent = `${Math.max(0, max - elapsed).toFixed(1)}s`;
  }
  if (playing) {
    const pos = state.engine.position;
    arrangement.frame(pos, state.section);
    updateTime(Math.min(pos, state.song.totalSteps));
    visualizer?.setPosition(pos);
    drawScope(el.scope, lcdColors(el.scope.parentElement), state.engine.analyser.getValue());
  }
  if (recording || playing) requestAnimationFrame(loop);
  else {
    looping = false;
    drawScope(el.scope, lcdColors(el.scope.parentElement), null);
    el.rec.style.setProperty('--level', 0);
  }
}

function drawArrangement() {
  arrangement.frame(state.engine?.isPlaying ? state.engine.position : 0, state.section);
}

function redrawAll() {
  buildKeyboard(); // switches between one and two octaves with the screen
  applyMoodColors();
  drawSampleLcd();
  drawSlots();
  refreshArrangement();
  drawScope(el.scope, lcdColors(el.scope.parentElement), null);
  visualizer?.refreshColors();
}

// ---------------------------------------------------------------------------
// events

el.rec.addEventListener('click', recordWord);
el.demo.addEventListener('click', () => {
  useDemoVoice();
  say('Demo voice loaded.');
});
el.upload.addEventListener('change', () => {
  loadFile(el.upload.files[0]);
  el.upload.value = '';
});
for (const chip of el.sliceModes) {
  chip.addEventListener('click', () => {
    state.sliceMode = chip.dataset.slices;
    for (const c of el.sliceModes) c.setAttribute('aria-checked', String(c === chip));
    resliceVoice();
  });
}
el.wave.addEventListener('click', (e) => {
  const v = state.voice;
  if (!v) return;
  const r = el.wave.getBoundingClientRect();
  const rawIndex = ((e.clientX - r.left) / r.width) * v.raw.length - v.start;
  const i = v.slices.findIndex((s) => rawIndex >= s.start && rawIndex < s.end);
  if (i >= 0) playJam(i);
});
document.addEventListener('pointerdown', (e) => {
  const pad = e.target.closest?.('.jam-pad');
  if (!pad) return;
  e.preventDefault();
  playJam(Number(pad.dataset.slice));
});

el.moodPads.addEventListener('click', (e) => {
  const pad = e.target.closest('.pad');
  if (!pad) return;
  ensureEngine().catch(() => {});
  newSong(pad.dataset.mood);
});
el.play.addEventListener('click', togglePlay);
el.topPlay.addEventListener('click', togglePlay);
el.dockPlay.addEventListener('click', togglePlay);
el.dockRec.addEventListener('click', recordWord);
$('#dock-stage').addEventListener('click', () => setStage(true));
$('#oct-down').addEventListener('click', () => {
  state.kbOctave = Math.max(-2, state.kbOctave - 1);
  buildKeyboard();
});
$('#oct-up').addEventListener('click', () => {
  state.kbOctave = Math.min(2, state.kbOctave + 1);
  buildKeyboard();
});
// the first touch anywhere unlocks sound on iPhones; later ones revive it after calls
document.addEventListener('pointerdown', () => {
  unlockIOSAudio();
  resumeAudio();
}, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeAudio();
  updateWakeLock();
});
el.hudPlay.addEventListener('click', togglePlay);
const roll = () => {
  el.randomize.classList.remove('is-rolling');
  void el.randomize.offsetWidth; // restart the dice animation
  el.randomize.classList.add('is-rolling');
  newSong();
};
el.randomize.addEventListener('click', roll);
el.hudRandom.addEventListener('click', roll);
$('#dock-new').addEventListener('click', roll);
el.newMelody.addEventListener('click', () => {
  state.recipe.melodySeed = randomSeed();
  rebuild();
  say('New melody, same everything else.');
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
    setFx({ [input.dataset.fx]: Number(input.value) });
  });
}

el.keyboard.addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.key');
  if (!key) return;
  e.preventDefault();
  key.setPointerCapture?.(e.pointerId);
  key.dataset.pointer = e.pointerId;
  pressKey(Number(key.dataset.midi), 'screen');
});
for (const type of ['pointerup', 'pointercancel']) {
  el.keyboard.addEventListener(type, (e) => {
    const key = e.target.closest('.key');
    if (key) releaseKey(Number(key.dataset.midi));
  });
}
$('#key-modes').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-keymode]');
  if (chip) setKeyMode(chip.dataset.keymode);
});
fillSelect($('#live-type'), Object.entries(CHORD_TYPES));
$('#live-type').addEventListener('change', (e) => (state.liveType = e.target.value));
$('#live-loop').addEventListener('change', (e) => state.engine?.setLoopDrop(state.keyMode === 'chords' && e.target.checked));
$('#midi-connect').addEventListener('click', connectMidi);

el.scenes.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scene]');
  if (b) setScene(b.dataset.scene);
});
el.stageWord.addEventListener('input', () => {
  state.word = el.stageWord.value.trim();
  visualizer?.setWord(state.word);
  updateHud();
});
el.orbit.addEventListener('change', async () => {
  (await ensureEngine()).setOrbit(el.orbit.checked);
  if (el.orbit.checked) say('8D on: the chops now circle your head. Put headphones on.');
});
el.stageOpen.addEventListener('click', () => setStage(true));
el.stageExit.addEventListener('click', () => setStage(false));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.stage) setStage(false);
  setTimeout(() => visualizer?.resize(), 50);
});

$('#exhibit-open').addEventListener('click', openExhibit);
$('#exhibit-exit').addEventListener('click', closeExhibit);
$('#ex-rec').addEventListener('click', exhibitRecord);
$('#ex-retry').addEventListener('click', () => showExhibitScreen('attract'));
$('#ex-again').addEventListener('click', resetExhibit);
$('#ex-moods').addEventListener('click', (e) => {
  const tile = e.target.closest('.exhibit-mood');
  if (tile) exhibitPick(tile.dataset.mood);
});
el.exhibit.addEventListener('pointerdown', touchExhibit);

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.matches('input[type="text"], textarea, select') || target.isContentEditable);
  if (e.key === 'Escape') {
    if (state.stage) setStage(false);
    else if (state.exhibit) closeExhibit();
    return;
  }
  if (typing) return;
  if (e.code === 'Space') {
    // always the transport, even when a button has focus (Enter still clicks it)
    e.preventDefault();
    if (state.exhibit) return;
    togglePlay();
    return;
  }
  const k = e.key.toLowerCase();
  if (/^[1-8]$/.test(k)) {
    playJam(Number(k) - 1);
    return;
  }
  if (state.exhibit) return;
  if (k === 'r') {
    recordWord();
    return;
  }
  if (k === 'f') {
    setStage(!state.stage);
    return;
  }
  if (k === 'c') {
    setKeyMode(state.keyMode === 'chords' ? 'word' : 'chords');
    return;
  }
  const i = KEY_MAP.indexOf(k);
  if (i >= 0) {
    flashKey(state.kbStart + i, 0.2);
    pressKey(state.kbStart + i, 'kbd');
  }
});
document.addEventListener('keyup', (e) => {
  const i = KEY_MAP.indexOf(e.key.toLowerCase());
  if (i >= 0) releaseKey(state.kbStart + i);
});

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawAll, 60);
}).observe(document.body);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);
new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// only animate the visuals while they're on screen
if (visualizer) {
  new IntersectionObserver((entries) => {
    const visible = entries.some((en) => en.isIntersecting) || state.exhibit || state.stage;
    if (visible) visualizer.start();
    else visualizer.stop();
  }).observe(el.stage);
}

// ---------------------------------------------------------------------------
// start in a playable state: demo voice + a hype track ready to go

buildMoodPads();
buildStudio();
wireStudio();
buildMixer();
buildSlots();
buildScenes();
wireXY();
if (!micSupported()) {
  el.rec.disabled = true;
  $('#ex-rec').disabled = true;
  $$('.slot-rec').forEach((b) => (b.disabled = true));
  $('#sample-hint').textContent =
    "The mic isn't available on this page, so upload a short voice memo of a word (or keep the demo voice).";
}
useDemoVoice({ audition: false });
setRecipe(rollRecipe('hype', randomSeed()));
visualizer?.setScene(state.scene);
visualizer?.start();
if (document.fonts?.ready) document.fonts.ready.then(redrawAll);
if (location.hash === '#exhibit') openExhibit();

// Installable and offline-capable when served from a real site.
const servedForReal = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if ('serviceWorker' in navigator && servedForReal && window.self === window.top) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// handy for poking at things from the console
window.chopShop = { state, newSong, setRecipe, MOODS };
