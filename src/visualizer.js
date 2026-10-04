// The stage: a big LCD screen that dances to the song. Canvas 2D only.
//
// Everything that moves is driven by a few smoothed signals (kick, snare, hat,
// the drop's impact, section energy and build tension) plus the analysers.
// Vocal chops are kept as timestamped notes, so each scene draws them its own
// way and switching scenes mid-song loses nothing. Colours come from CSS
// (--stage-bg, --stage-ink, --accent), so the stage follows theme and mood.
//
// The canvas is expected to be sized by CSS (e.g. width/height: 100% of its
// container); this only sizes its backing store.

export const SCENES = {
  auto: 'Auto',
  spectrum: 'Spectrum',
  orbit: 'Orbit',
  horizon: 'Horizon',
  word: 'Word',
  drift: 'Drift',
};

const TAU = Math.PI * 2;
const BANDS = 64;
const WAVE = 160;
const HISTORY = 4;
const MAX_SPARKS = 768;
const MAX_NOTES = 48;
const MAX_RINGS = 24;
const F_LO = 35;
const F_HI = 15000;
const MAX_PIXELS = 3840 * 2160;
const NO_DASH = [];
const GRID_BANDS = [0, 0.03, 0.07, 0.13, 0.22, 0.36, 0.56, 1];
const gridFade = (d) => (d < 0.1 ? d * 2.5 : 0.25 + 0.78 * (d - 0.1));
const PT = new Float64Array(2); // scratch point, so position helpers don't allocate

// spark shapes and colour slots
const GLOW = 0;
const PIXEL = 1;
const STREAK = 2;
const TWINKLE = 3;
const ACCENT = 0;
const INK = 1;
const ACCENT2 = 2;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIDI_NAMES = Array.from({ length: 128 }, (_, m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`);
// a small hue move (degrees) per chord of the progression
const CHORD_HUES = [0, -10, 8, -5, 12, -8, 4, -12];

/**
 * How each mood moves. lift: +1 floats up, -1 sinks. punch scales the hits,
 * kickDecay how fast they let go, fall how fast spectrum peaks drop, spring
 * how stiffly the chopped word snaps back, motion picks particle behaviour.
 * Moods without an entry borrow one by tempo.
 */
const FEELS = {
  sad: {
    pace: 0.55,
    punch: 0.5,
    lift: -1,
    sway: 0.5,
    kickDecay: 5.5,
    fall: 0.7,
    spring: 30,
    chop: 0.2,
    motion: 'rain',
  },
  hype: { pace: 1.15, punch: 1, lift: 0.3, sway: 0.1, kickDecay: 10, fall: 3, spring: 220, chop: 1, motion: 'warp' },
  dreamy: {
    pace: 0.7,
    punch: 0.45,
    lift: 1,
    sway: 1,
    kickDecay: 5.5,
    fall: 0.45,
    spring: 70,
    chop: 0.55,
    motion: 'bokeh',
  },
};

// What Auto shows per mood and section. 'word' is skipped (for `spare`)
// until there is a word to show.
const AUTO = {
  sad: { idle: 'drift', intro: 'drift', build: 'word', drop: ['orbit', 'horizon'], outro: 'drift', spare: 'spectrum' },
  hype: {
    idle: 'horizon',
    intro: 'spectrum',
    build: 'orbit',
    drop: ['horizon', 'word'],
    outro: 'spectrum',
    spare: 'drift',
  },
  dreamy: {
    idle: 'orbit',
    intro: 'drift',
    build: 'orbit',
    drop: ['word', 'horizon'],
    outro: 'drift',
    spare: 'spectrum',
  },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fract = (v) => v - Math.floor(v);
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const feelForTempo = (bpm) => (bpm >= 112 ? 'hype' : bpm <= 86 ? 'sad' : 'dreamy');

// Deterministic randoms for layouts that should look the same every time.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- colour -----------------------------------------------------------------

let probe = null;

// Any CSS colour to [r, g, b]. Hex and rgb() are parsed directly; anything
// else (names, hsl(), color-mix()) is resolved by painting one pixel.
function parseColor(text, fallback) {
  const s = (text || '').trim();
  if (!s) return fallback;
  let m = /^#([\da-f]{3,8})$/i.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return fallback;
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  m = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (m) {
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3);
    const rgb = parts.map((p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p)));
    if (rgb.length === 3 && rgb.every(Number.isFinite)) return rgb.map((c) => clamp(Math.round(c), 0, 255));
  }
  try {
    if (!probe) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      probe = c.getContext('2d', { willReadFrequently: true });
    }
    probe.fillStyle = '#010203';
    probe.fillStyle = s;
    if (probe.fillStyle === '#010203') return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch {
    return fallback;
  }
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    t = fract(t);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((c) => Math.round(c * 255));
}

const css = (c, a = 1) => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// Soft round sprites stand in for shadowBlur, which is far too slow per frame.
function paintSprite(canvas, rgb, soft) {
  const g = canvas.getContext('2d');
  const n = canvas.width;
  g.clearRect(0, 0, n, n);
  const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  const stops = soft
    ? [
        [0, 0.6],
        [0.62, 0.5],
        [0.84, 0.16],
        [1, 0],
      ]
    : [
        [0, 1],
        [0.14, 0.62],
        [0.4, 0.18],
        [1, 0],
      ];
  for (const [at, a] of stops) grad.addColorStop(at, css(rgb, a));
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
}

function makeSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  return c;
}

// --- pools ------------------------------------------------------------------

// Short-lived particles in flat typed arrays; the oldest is recycled when full.
class Sparks {
  constructor(n) {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.col = new Uint8Array(n);
    this.next = 0;
  }

  spawn(x, y, vx, vy, life, size, kind, col, grav = 0, drag = 0) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.kind[i] = kind;
    this.col[i] = col;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  clear() {
    this.life.fill(0);
    this.age.fill(0);
  }

  update(dt) {
    if (!dt) return;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      if (this.drag[i]) {
        const f = Math.exp(-this.drag[i] * dt);
        this.vx[i] *= f;
        this.vy[i] *= f;
      }
      this.vy[i] += this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }
  }
}

// Expanding outlines (kick shockwaves, the drop).
class Rings {
  constructor(n) {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.r0 = new Float32Array(n);
    this.r1 = new Float32Array(n);
    this.born = new Float64Array(n);
    this.life = new Float32Array(n);
    this.lw = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.col = new Uint8Array(n);
    this.next = 0;
  }

  spawn(x, y, r0, r1, born, life, lw, alpha, col) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.x[i] = x;
    this.y[i] = y;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.born[i] = born;
    this.life[i] = life;
    this.lw[i] = lw;
    this.alpha[i] = alpha;
    this.col[i] = col;
  }

  clear() {
    this.life.fill(0);
  }

  draw(ctx, t, colors) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      const p = (t - this.born[i]) / this.life[i];
      if (p >= 1) {
        this.life[i] = 0;
        continue;
      }
      if (p < 0) continue;
      const r = this.r0[i] + (this.r1[i] - this.r0[i]) * (1 - (1 - p) ** 3);
      ctx.globalAlpha = this.alpha[i] * (1 - p) * (1 - p);
      ctx.strokeStyle = colors[this.col[i]];
      ctx.lineWidth = Math.max(0.5, this.lw[i] * (1 - 0.6 * p));
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// --- the visualizer ---------------------------------------------------------

export class Visualizer {
  constructor(canvas, { hud = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.hud = hud;
    this.fft = null;
    this.waveform = null;
    this.song = null;
    this.mood = '';
    this.feelKey = 'hype';
    this.feel = FEELS.hype;
    this.sceneId = 'auto';
    this.current = '';
    this.word = '';
    this.label = 'CHOP SHOP';
    this.playing = false;
    this.step = 0;
    this.running = false;
    this.disposed = false;
    this.raf = 0;
    this.lastT = 0;
    this.lastFrame = 0;
    this.visible = true;
    this.framed = false;
    this.settling = false;

    this.w = 1;
    this.h = 1;
    this.scale = 1;
    this.k = 1;
    this.sizeDirty = true;

    // smoothed signals
    this.kick = 0;
    this.snare = 0;
    this.hat = 0;
    this.impact = 0;
    this.wash = 0;
    this.lastWash = -9;
    this.energy = 0.1;
    this.tension = 0;
    this.hold = 0;
    this.live = 0;
    this.punch = 1;
    this.calm = 1;
    this.beatPhase = 0;
    this.beatEnv = 0;
    this.beatIndex = -1;
    this.travel = 0;
    this.spin = 0;
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.ceilDb = -36;
    this.wavePeak = 0.2;

    this.spec = new Float32Array(BANDS);
    this.raw = new Float32Array(BANDS);
    this.avg = new Float32Array(BANDS);
    this.binLo = new Int32Array(BANDS);
    this.binHi = new Int32Array(BANDS);
    this.binC = new Float32Array(BANDS);
    this.tilt = new Float32Array(BANDS);
    this.binLen = 0;
    this.binRate = 0;
    this.wave = new Float32Array(WAVE);
    this.hist = Array.from({ length: HISTORY }, () => new Float32Array(WAVE));
    this.histIdx = 0;
    this.histAt = 0;

    this.sec = { ref: null, id: '', name: '', at: 0, progress: 0, bar: 0, bars: 0 };
    this.chord = { index: -1, symbol: '', roman: '' };
    this.hueShift = 0;
    this.hueTarget = 0;
    this.palShift = 0;
    this.pLo = 50;
    this.pHi = 76;
    this.seenLo = 999;
    this.seenHi = -999;

    this.sparks = new Sparks(MAX_SPARKS);
    this.rings = new Rings(MAX_RINGS);
    this.notes = {
      born: new Float64Array(MAX_NOTES).fill(-1e9),
      midi: new Float32Array(MAX_NOTES),
      dur: new Float32Array(MAX_NOTES),
      vel: new Float32Array(MAX_NOTES),
      seed: new Float32Array(MAX_NOTES),
      pn: new Float32Array(MAX_NOTES),
      next: 0,
    };
    // events wait here until the next frame, when the current scene spawns things for them
    this.queue = Array.from({ length: 32 }, () => ({ type: '', vel: 0, midi: 0, dur: 0, pn: 0, seed: 0 }));
    this.queued = 0;

    this.state = {};
    this.snap = null;
    this.transAt = -9;
    this.transDur = 0.8;
    this.pal = { bgCss: '#000', inkCss: '#fff', accentCss: '#f80', accent2Css: '#fc0', cols: ['#f80', '#fff', '#fc0'] };
    this.inkVer = 0;
    this.palVer = 0;
    this.textVer = 0; // bumps when the label or the fonts change
    this.fontsAsked = new Set();
    this.glow = [makeSprite(), makeSprite(), makeSprite()];
    this.bokeh = [makeSprite(), makeSprite(), makeSprite()];
    this.measure = document.createElement('canvas').getContext('2d');
    this.overlay = null;
    this.overlayKey = '';
    this.hudText = { playing: null, sec: '', bar: 0, bars: 0, chord: '', fs: 0, song: null, mood: '', textVer: -1 };
    this.dash = [5, 5];
    this.colorAt = -9;
    this.colorKey = '';

    this.motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reduced = Boolean(this.motionQuery?.matches);
    this._onMotion = (e) => {
      this.reduced = e.matches;
      this._still();
    };
    this.motionQuery?.addEventListener?.('change', this._onMotion);

    this._tick = (now) => {
      this.raf = 0;
      if (!this.running || this.disposed || document.hidden || !this.visible) return;
      // nothing is playing: 30 fps is plenty for the ambient motion
      if (!this.playing && now - this.lastFrame < 31) {
        this._schedule();
        return;
      }
      this.lastFrame = now;
      this.render(now);
      this._schedule();
    };
    this._onVisibility = () => {
      if (document.hidden) this._cancel();
      else this._schedule();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    if (typeof IntersectionObserver === 'function') {
      this.intersection = new IntersectionObserver((entries) => {
        this.visible = entries[entries.length - 1].isIntersecting;
        if (this.visible) this._schedule();
      });
      this.intersection.observe(canvas);
    }

    this.refreshColors();
  }

  // --- public API -----------------------------------------------------------

  setAnalysers({ fft = null, waveform = null } = {}) {
    this.fft = fft;
    this.waveform = waveform;
  }

  setSong(song) {
    this.song = song || null;
    this.sec.ref = null;
    this.sec.id = '';
    this.chord.index = -1;
    this.chord.symbol = '';
    this.chord.roman = '';
    this.hueTarget = 0;
    this.seenLo = 999;
    this.seenHi = -999;
    const vox = song?.tracks?.vox;
    if (Array.isArray(vox)) {
      for (const n of vox) {
        if (!Number.isFinite(n.midi)) continue;
        this.seenLo = Math.min(this.seenLo, n.midi);
        this.seenHi = Math.max(this.seenHi, n.midi);
      }
    }
    if (song?.mood && song.mood !== this.mood) this.setMood(song.mood);
    else this._pickFeel();
    this._still();
  }

  setMood(moodId) {
    this.mood = String(moodId ?? '');
    this._pickFeel();
    this._setLabel();
    this._still();
  }

  setScene(id) {
    this.sceneId = Object.hasOwn(SCENES, id) ? id : 'auto';
    this._still();
  }

  setWord(text) {
    this.word = String(text ?? '').trim();
    this._setLabel();
    this._still();
  }

  setPlaying(playing) {
    playing = Boolean(playing);
    if (playing === this.playing) return;
    this.playing = playing;
    this.sec.ref = null;
    this.sec.id = '';
    if (!playing) {
      this.chord.symbol = '';
      this.hueTarget = 0;
    }
    this._still();
  }

  setPosition(step) {
    if (Number.isFinite(step)) this.step = step;
  }

  event(type, data) {
    const t = performance.now() / 1000;
    const vel = clamp(data?.vel == null ? 1 : Number(data.vel) || 0, 0, 1);
    let midi = 0;
    let dur = 0;
    switch (type) {
      case 'kick':
        this.kick = Math.max(this.kick, 0.35 + 0.65 * vel);
        break;
      case 'snare':
        this.snare = Math.max(this.snare, 0.3 + 0.7 * vel);
        // soft full-screen tint, never more than ~3 a second
        if (!this.reduced && t - this.lastWash >= 0.34) {
          this.wash = Math.max(this.wash, 0.045 * vel * (0.4 + 0.6 * this.energy));
          this.lastWash = t;
        }
        break;
      case 'hat':
        this.hat = Math.max(this.hat, vel);
        break;
      case 'vox': {
        midi = Number(data?.midi);
        if (!Number.isFinite(midi)) return;
        dur = clamp(Number(data?.dur) || 0.25, 0.03, 4);
        this.seenLo = Math.min(this.seenLo, midi);
        this.seenHi = Math.max(this.seenHi, midi);
        break;
      }
      case 'chord': {
        const index = Number(data?.index);
        this.chord.index = Number.isInteger(index) ? index : this.chord.index + 1;
        this.chord.symbol = String(data?.symbol ?? '');
        this.chord.roman = this.song?.chords?.[this.chord.index]?.roman ?? '';
        const i = ((this.chord.index % CHORD_HUES.length) + CHORD_HUES.length) % CHORD_HUES.length;
        this.hueTarget = CHORD_HUES[i] * (this.reduced ? 0.6 : 1);
        break;
      }
      case 'section': {
        const id = String(data?.id ?? '');
        if (id !== this.sec.id) {
          this.sec.id = id;
          this.sec.name = String(data?.name ?? id);
          this.sec.at = t;
          this.sec.ref = null;
          this.sec.progress = 0;
        }
        break;
      }
      case 'impact':
        this.impact = 1;
        this.energy = Math.max(this.energy, 0.9);
        if (t - this.lastWash >= 0.34) {
          this.wash = Math.max(this.wash, this.reduced ? 0.05 : 0.11);
          this.lastWash = t;
        }
        break;
      default:
        return;
    }

    const seed = Math.random();
    const pn = this._pitchNorm(midi);
    if (type === 'vox') {
      const N = this.notes;
      const i = N.next;
      N.next = (i + 1) % MAX_NOTES;
      N.born[i] = t;
      N.midi[i] = midi;
      N.dur[i] = dur;
      N.vel[i] = vel;
      N.seed[i] = seed;
      N.pn[i] = pn;
    }
    if (this.queued < this.queue.length) {
      const q = this.queue[this.queued++];
      q.type = type;
      q.vel = vel;
      q.midi = midi;
      q.dur = dur;
      q.pn = pn;
      q.seed = seed;
    }
  }

  // Re-read the CSS custom properties (theme or mood changed).
  refreshColors() {
    const cs = getComputedStyle(this.canvas);
    const get = (name) => cs.getPropertyValue(name).trim();
    const bgText = get('--stage-bg') || get('--lcd');
    const inkText = get('--stage-ink') || get('--ink');
    const accentText = get('--accent');
    const fontUi = get('--font-ui') || 'sans-serif';
    const fontLcd = get('--font-lcd') || 'monospace';
    if (fontUi !== this.fontUi || fontLcd !== this.fontLcd) this.textVer++;
    this.colorKey = `${bgText}|${inkText}|${accentText}|${fontUi}|${fontLcd}`;

    this.bg = parseColor(bgText, [10, 12, 13]);
    this.dark = luminance(this.bg) < 0.45;
    this.ink = parseColor(inkText, this.dark ? [237, 235, 240] : [28, 27, 31]);
    this.accentHsl = rgbToHsl(parseColor(accentText, [255, 123, 58]));
    this.fontUi = fontUi;
    this.fontLcd = fontLcd;
    this.pal.bgCss = css(this.bg);
    this.pal.inkCss = css(this.ink);
    paintSprite(this.glow[INK], this.ink, false);
    paintSprite(this.bokeh[INK], this.ink, true);
    this.inkVer++;
    this._buildAccent();
    this._loadFonts();
    this._still();
  }

  resize() {
    this.sizeDirty = true;
    this._still();
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastT = performance.now() / 1000;
    this._schedule();
  }

  // Stops the loop and leaves a finished frame on screen.
  stop() {
    this.running = false;
    this._cancel();
    this.snap = null; // no half-finished scene fade in the still frame
    if (!this.disposed) this.render(performance.now(), !this.playing);
  }

  dispose() {
    this.running = false;
    this._cancel();
    this.disposed = true;
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.motionQuery?.removeEventListener?.('change', this._onMotion);
    this.resizeObserver?.disconnect();
    this.intersection?.disconnect();
    for (const scene of Object.values(SCENE_IMPL)) scene.leave?.(this);
    if (this.overlay) this.overlay.width = this.overlay.height = 0;
    this.snap = null;
    this.state = {};
  }

  // Draws one frame. The loop calls this; `settle` draws a calm, finished
  // frame (no half-faded transitions or leftover hits) for still pictures.
  render(now = performance.now(), settle = false) {
    if (this.disposed) return;
    if (this.sizeDirty) this._applySize();
    const { w, h } = this;
    if (w < 2 || h < 2) return;
    const t = now / 1000;
    const dt = settle ? 0 : clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    this.settling = settle;
    if (t - this.colorAt > 0.5) this._checkColors(t);

    this._update(t, dt, settle);
    const id = this.sceneId === 'auto' ? this._autoScene() : this.sceneId;
    if (id !== this.current) this._switchScene(id, t, settle);
    const scene = SCENE_IMPL[this.current];
    for (let i = 0; i < this.queued; i++) scene.hit(this, this.queue[i], t);
    this.queued = 0;
    if (settle) {
      this.sparks.clear();
      this.rings.clear();
      this.notes.born.fill(-1e9);
      this.transAt = -9;
    }
    this.sparks.update(dt);

    const ctx = this.ctx;
    const s = this.scale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.pal.bgCss;
    ctx.fillRect(0, 0, w, h);

    // a little camera shake on hard kicks and the drop (never with reduced motion)
    if (!this.reduced) {
      const amt =
        (this.kick * this.kick * this.feel.punch * this.energy * 0.004 + this.impact ** 3 * 0.012) * Math.min(w, h);
      if (amt > 0.2) ctx.translate(Math.sin(t * 91) * amt, Math.cos(t * 73) * amt);
    }

    scene.draw(this, ctx, w, h, t, dt);
    this.rings.draw(ctx, t, this.pal.cols);
    this._drawSparks(ctx);

    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (this.wash > 0.004) {
      ctx.globalAlpha = this.wash;
      ctx.fillStyle = this.pal.accentCss;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (this.hud) this._drawHud(ctx, w, h);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._overlay(), 0, 0);
    if (this.snap) {
      const tp = (t - this.transAt) / this.transDur;
      if (tp >= 0 && tp < 1) {
        ctx.globalAlpha = 1 - tp * tp * (3 - 2 * tp);
        ctx.drawImage(this.snap, 0, 0);
        ctx.globalAlpha = 1;
      } else if (tp >= 1 || tp < 0) {
        this.snap = null; // full-size canvases are big; only keep it for the fade
      }
    }
    this.framed = true;
    this.settling = false;
  }

  // --- internals ------------------------------------------------------------

  _schedule() {
    if (!this.raf && this.running && !this.disposed && !document.hidden && this.visible) {
      this.raf = requestAnimationFrame(this._tick);
    }
  }

  _cancel() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // Redraw by hand when the loop isn't running (resize clears the canvas).
  _still() {
    if (!this.running && !this.disposed) this.render(performance.now(), !this.playing);
  }

  _pickFeel() {
    this.feelKey = FEELS[this.mood] ? this.mood : feelForTempo(this.song?.bpm ?? 100);
    this.feel = FEELS[this.feelKey];
  }

  _pitchNorm(midi) {
    return clamp((midi - this.pLo) / (this.pHi - this.pLo), 0, 1);
  }

  // What the type scenes spell out: the word, or the mood until there is one.
  _setLabel() {
    const label = (this.word || this.mood || 'chop shop').toLocaleUpperCase();
    if (label !== this.label) {
      this.label = label;
      this.textVer++;
    }
  }

  _applySize() {
    this.sizeDirty = false;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    let s = Math.min(2, window.devicePixelRatio || 1);
    if (w * h * s * s > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / (w * h));
    const bw = Math.max(1, Math.round(w * s));
    const bh = Math.max(1, Math.round(h * s));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.w = w;
    this.h = h;
    this.scale = bw / w;
    this.k = clamp(Math.min(w, h) / 420, 0.55, 3);
  }

  _checkColors(t) {
    this.colorAt = t;
    const cs = getComputedStyle(this.canvas);
    const get = (name) => cs.getPropertyValue(name).trim();
    const key = `${get('--stage-bg') || get('--lcd')}|${get('--stage-ink') || get('--ink')}|${get('--accent')}|${
      get('--font-ui') || 'sans-serif'
    }|${get('--font-lcd') || 'monospace'}`;
    if (key !== this.colorKey) this.refreshColors();
  }

  _buildAccent() {
    const [h, s, l] = this.accentHsl;
    const shift = this.hueShift;
    const accent = hslToRgb(h + shift, s, l);
    // a neighbouring hue for highlights, kept about as legible as the accent
    const accent2 = hslToRgb(
      h + shift + (this.dark ? 25 : 24),
      Math.min(1, s * 1.05),
      this.dark ? Math.min(0.8, l + 0.06) : Math.max(0.28, l - 0.04),
    );
    this.accent = accent;
    this.accent2 = accent2;
    this.pal.accentCss = css(accent);
    this.pal.accent2Css = css(accent2);
    this.pal.cols[ACCENT] = this.pal.accentCss;
    this.pal.cols[INK] = this.pal.inkCss;
    this.pal.cols[ACCENT2] = this.pal.accent2Css;
    paintSprite(this.glow[ACCENT], accent, false);
    paintSprite(this.glow[ACCENT2], accent2, false);
    paintSprite(this.bokeh[ACCENT], accent, true);
    paintSprite(this.bokeh[ACCENT2], accent2, true);
    this.palShift = shift;
    this.palVer++;
  }

  // Canvas text only uses web fonts that are already loaded; ask for them.
  _loadFonts() {
    if (!document.fonts?.load) return;
    for (const spec of [`900 64px ${this.fontUi}`, `24px ${this.fontLcd}`]) {
      if (this.fontsAsked.has(spec)) continue;
      this.fontsAsked.add(spec);
      document.fonts
        .load(spec)
        .then((faces) => {
          if (!faces.length || this.disposed) return;
          this.textVer++;
          this._still();
        })
        .catch(() => {});
    }
  }

  _mapBins(len, rate) {
    const hz = rate / 2 / len;
    const ratio = F_HI / F_LO;
    for (let b = 0; b < BANDS; b++) {
      const f0 = F_LO * ratio ** (b / BANDS);
      const f1 = F_LO * ratio ** ((b + 1) / BANDS);
      const fc = Math.sqrt(f0 * f1);
      this.binLo[b] = clamp(Math.floor(f0 / hz), 0, len - 1);
      this.binHi[b] = clamp(Math.ceil(f1 / hz), this.binLo[b] + 1, len);
      this.binC[b] = Math.min(len - 1.001, fc / hz);
      // real mixes fall off toward the top; lift the highs so they still move
      this.tilt[b] = Math.max(0, 3 * Math.log2(fc / 500));
    }
    this.binLen = len;
    this.binRate = rate;
  }

  _readAnalysers(t, dt, edt) {
    const fft = this.fft?.getValue ? this.fft.getValue() : null;
    const usable = fft && fft.length >= 16;
    let loud = -140;
    if (usable) {
      const rate = this.fft.context?.sampleRate || globalThis.Tone?.getContext?.()?.sampleRate || 48000;
      if (fft.length !== this.binLen || rate !== this.binRate) this._mapBins(fft.length, rate);
      for (let b = 0; b < BANDS; b++) {
        const lo = this.binLo[b];
        const hi = this.binHi[b];
        let db = -140;
        if (hi - lo > 2) {
          for (let i = lo; i < hi; i++) if (fft[i] > db) db = fft[i];
        } else {
          const c = this.binC[b];
          const i0 = c | 0;
          const a = fft[i0] > -140 ? fft[i0] : -140;
          const z = fft[i0 + 1] > -140 ? fft[i0 + 1] : -140;
          db = a + (z - a) * (c - i0);
        }
        this.raw[b] = db;
        if (db > loud) loud = db;
      }
    }
    // a slow follower lifts a quiet master (low volume fader) back into view
    this.ceilDb = Math.max(loud, this.ceilDb - 0.6 * dt, -60);
    const boost = clamp(-33 - this.ceilDb, 0, 12);
    this.live = ease(this.live, usable && (this.playing || loud > -85) ? 1 : 0, this.playing ? 3 : 1.2, edt);
    const release = 4 + 5 * this.feel.pace;
    const up = 1 - Math.exp(-30 * dt);
    const down = 1 - Math.exp(-release * dt);
    const slow = 1 - Math.exp(-1.2 * dt);
    let bass = 0;
    let mid = 0;
    let high = 0;
    for (let b = 0; b < BANDS; b++) {
      let real = 0;
      if (usable) {
        // a curve for headroom, plus whatever pokes above the recent average
        const abs = clamp((this.raw[b] + this.tilt[b] + boost + 75) / 45, 0, 1);
        this.avg[b] += (abs - this.avg[b]) * slow;
        real = clamp(abs ** 1.5 * 0.9 + Math.max(0, abs - this.avg[b]) * 1.4, 0, 1);
      }
      const x = b / BANDS;
      // the ambient shape used while nothing plays: slow drifting hills
      const idle = (0.26 + 0.17 * Math.sin(t * 0.55 + x * 9) + 0.08 * Math.sin(t * 1.17 - x * 17)) * (1 - 0.45 * x);
      const target = idle + (real - idle) * this.live;
      const cur = this.spec[b];
      this.spec[b] = edt > 1 ? target : cur + (target - cur) * (target > cur ? up : down);
      if (b < 10) bass += this.spec[b];
      else if (b >= 16 && b < 38) mid += this.spec[b];
      else if (b >= 44 && b < 62) high += this.spec[b];
    }
    this.bass = bass / 10;
    this.mid = mid / 22;
    this.high = high / 18;

    // waveform: trigger on a rising zero crossing like a scope so it holds still
    const wf = this.waveform?.getValue ? this.waveform.getValue() : null;
    const n = wf ? wf.length : 0;
    let start = 0;
    let span = 0;
    let peak = 0;
    if (n >= 32) {
      span = n >> 1;
      for (let i = 1; i < n - span; i++) {
        if (wf[i - 1] < 0 && wf[i] >= 0) {
          start = i;
          break;
        }
      }
      for (let i = 0; i < n; i++) {
        const a = Math.abs(wf[i]);
        if (a > peak) peak = a;
      }
    }
    this.wavePeak = Math.max(peak, this.wavePeak * Math.exp(-0.4 * dt), 0.05);
    const gain = clamp(0.85 / this.wavePeak, 1, 6);
    const mix = span ? this.live : 0;
    const smooth = edt > 1 ? 1 : 1 - Math.exp(-35 * dt);
    for (let i = 0; i < WAVE; i++) {
      const u = i / WAVE;
      const idle = 0.5 * Math.sin(u * TAU * 2 + t * 0.9) * (0.6 + 0.4 * Math.sin(t * 0.37 + u * 8));
      let real = 0;
      if (span) {
        // a short average takes the fizz (hats, noise) off the line
        const j = start + ((u * span) | 0);
        real = ((wf[j - 1] ?? wf[j]) + wf[j] * 2 + (wf[j + 1] ?? wf[j])) * 0.25 * gain;
        if (!(real === real)) real = 0;
      }
      const target = idle + (clamp(real, -1.2, 1.2) - idle) * mix;
      this.wave[i] += (target - this.wave[i]) * smooth;
    }
    if (t - this.histAt > 0.05 || edt > 1) {
      this.histAt = t;
      this.histIdx = (this.histIdx + 1) % HISTORY;
      this.hist[this.histIdx].set(this.wave);
    }
  }

  _update(t, dt, settle) {
    const f = this.feel;
    const edt = settle ? 10 : dt;
    this.calm = this.reduced ? 0.35 : 1;
    this.punch = f.punch * (this.reduced ? 0.3 : 1);
    if (settle) {
      this.kick = this.snare = this.hat = this.impact = this.wash = 0;
    } else {
      this.kick *= Math.exp(-f.kickDecay * dt);
      this.snare *= Math.exp(-7 * dt);
      this.hat *= Math.exp(-16 * dt);
      this.impact *= Math.exp(-1.3 * dt);
      this.wash *= Math.exp(-9 * dt);
    }
    this._readAnalysers(t, dt, edt);

    // where we are in the song
    const sec = this.sec;
    const sections = this.song?.sections;
    if (this.playing && sections?.length) {
      const step = this.step;
      let found = sec.ref && step >= sec.ref.startStep && step < sec.ref.endStep ? sec.ref : null;
      for (let i = 0; !found && i < sections.length; i++) {
        if (step >= sections[i].startStep && step < sections[i].endStep) found = sections[i];
      }
      if (!found && step >= sections[sections.length - 1].endStep) found = sections[sections.length - 1];
      if (found) {
        if (found !== sec.ref) {
          sec.ref = found;
          sec.id = found.id;
          sec.name = found.name ?? found.id;
          sec.at = t;
        }
        const len = Math.max(1, found.endStep - found.startStep);
        sec.progress = clamp((step - found.startStep) / len, 0, 1);
        sec.bar = Math.min(Math.floor((step - found.startStep) / 16) + 1, found.bars ?? 99);
        sec.bars = found.bars ?? Math.round(len / 16);
      }
    } else if (this.playing && sec.id) {
      sec.progress = clamp((t - sec.at) / 15, 0, 1);
    }

    const id = this.playing ? sec.id : 'idle';
    const p = sec.progress;
    let target = 0.6;
    if (id === 'idle') target = 0.1;
    else if (id === 'intro') target = 0.3 + 0.12 * p;
    else if (id === 'build') target = 0.38 + 0.5 * p * p;
    else if (id === 'drop') target = 1;
    else if (id === 'outro') target = 0.65 - 0.45 * p;
    this.energy = ease(this.energy, target, target > this.energy ? 1.8 : 0.8, edt);
    this.tension = ease(this.tension, id === 'build' ? p : 0, id === 'build' ? 5 : 9, edt);
    // the composer leaves the last beat of the build silent
    const holding = id === 'build' && sec.ref && this.step >= sec.ref.endStep - 4 ? 1 : 0;
    this.hold = ease(this.hold, holding, holding ? 10 : 6, edt);

    const bpm = this.song?.bpm || 96;
    if (this.playing) {
      const beat = this.step / 4;
      this.beatPhase = fract(beat);
      this.beatIndex = Math.floor(beat) % 4;
    } else {
      this.beatPhase = fract((t * bpm) / 120);
      this.beatIndex = -1;
    }
    this.beatEnv = (1 - this.beatPhase) ** 3 * (this.playing ? 1 : 0.4);
    const go = this.playing ? 1 : 0.3;
    const rush = 1.6 * this.tension * (1 - this.hold);
    this.travel +=
      (bpm / 60) * f.pace * (0.25 + 0.95 * this.energy + rush) * this.calm * go * (1 - 0.85 * this.hold) * dt;
    this.spin += (0.06 + 0.3 * this.energy * f.pace + 0.9 * this.tension * (1 - this.hold)) * this.calm * go * dt;

    this.hueShift = ease(this.hueShift, this.hueTarget, 2.5, edt);
    if (Math.abs(this.hueShift - this.palShift) > 0.6) this._buildAccent();

    // stretch the vertical pitch mapping over the notes actually used
    let lo = 50;
    let hi = 76;
    if (this.seenLo <= this.seenHi) {
      const mid = (this.seenLo + this.seenHi) / 2;
      const half = Math.max(8, (this.seenHi - this.seenLo) / 2 + 2);
      lo = mid - half;
      hi = mid + half;
    }
    this.pLo = ease(this.pLo, lo, 0.8, edt);
    this.pHi = ease(this.pHi, hi, 0.8, edt);
  }

  _autoScene() {
    const plan = AUTO[this.mood] ?? AUTO[this.feelKey];
    let id = plan.idle;
    if (this.playing) {
      let pick = plan[this.sec.id] ?? plan.intro;
      if (Array.isArray(pick)) pick = pick[Math.min(pick.length - 1, Math.floor(this.sec.progress * pick.length))];
      id = pick;
    }
    return id === 'word' && !this.word ? plan.spare : id;
  }

  _switchScene(id, t, settle) {
    const prev = this.current;
    this.current = id;
    if (prev && !settle && this.framed) {
      // fade the last frame of the old scene out over the new one
      const c = this.canvas;
      this.snap ??= document.createElement('canvas');
      if (this.snap.width !== c.width || this.snap.height !== c.height) {
        this.snap.width = c.width;
        this.snap.height = c.height;
      }
      this.snap.getContext('2d').drawImage(c, 0, 0);
      this.transAt = t;
      this.transDur = this.impact > 0.6 ? 0.25 : 0.8;
    } else {
      this.transAt = -9;
      this.snap = null;
    }
    // the old scene's full-size caches aren't needed until it comes back
    SCENE_IMPL[prev]?.leave?.(this);
  }

  _drawSparks(ctx) {
    const S = this.sparks;
    const cols = this.pal.cols;
    ctx.globalCompositeOperation = this.dark ? 'lighter' : 'source-over';
    for (let i = 0; i < S.n; i++) {
      const kind = S.kind[i];
      if ((kind !== GLOW && kind !== TWINKLE) || S.age[i] >= S.life[i]) continue;
      const p = S.age[i] / S.life[i];
      ctx.globalAlpha = 1 - p;
      if (kind === GLOW) {
        const s = S.size[i] * (1 - 0.3 * p);
        ctx.drawImage(this.glow[S.col[i]], S.x[i] - s, S.y[i] - s, s * 2, s * 2);
      } else {
        // a four-point glint that opens and closes
        const s = S.size[i] * Math.sin(Math.PI * Math.min(1, p * 1.1 + 0.08));
        const th = Math.max(1, s * 0.2);
        ctx.fillStyle = cols[S.col[i]];
        ctx.fillRect(S.x[i] - s, S.y[i] - th / 2, s * 2, th);
        ctx.fillRect(S.x[i] - th / 2, S.y[i] - s, th, s * 2);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    let last = -1;
    for (let i = 0; i < S.n; i++) {
      const kind = S.kind[i];
      if ((kind !== PIXEL && kind !== STREAK) || S.age[i] >= S.life[i]) continue;
      ctx.globalAlpha = 1 - S.age[i] / S.life[i];
      const col = S.col[i];
      if (kind === PIXEL) {
        if (col !== last) ctx.fillStyle = cols[col];
        last = col;
        const s = S.size[i];
        ctx.fillRect(Math.round(S.x[i] - s / 2), Math.round(S.y[i] - s / 2), s, s);
      } else {
        ctx.strokeStyle = cols[col];
        ctx.lineWidth = S.size[i];
        ctx.beginPath();
        ctx.moveTo(S.x[i] - S.vx[i] * 0.05, S.y[i] - S.vy[i] * 0.05);
        ctx.lineTo(S.x[i], S.y[i]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Section and bar on the left with four beat lights; the chord on the right.
  _drawHud(ctx, w, h) {
    if (h < 150 || w < 240) return;
    const H = this.hudText;
    const fs = Math.round(clamp(Math.min(w, h) * 0.042, 14, 30));
    const sec = this.sec;
    const changed =
      H.playing !== this.playing ||
      H.sec !== sec.id ||
      H.bar !== sec.bar ||
      H.bars !== sec.bars ||
      H.chord !== this.chord.symbol ||
      H.fs !== fs ||
      H.song !== this.song ||
      H.mood !== this.mood ||
      H.textVer !== this.textVer;
    if (changed) {
      Object.assign(H, { playing: this.playing, sec: sec.id, bar: sec.bar, bars: sec.bars, chord: this.chord.symbol });
      Object.assign(H, { fs, song: this.song, mood: this.mood, textVer: this.textVer });
      H.font = `${fs}px ${this.fontLcd}`;
      const pad2 = (n) => String(n).padStart(2, '0');
      if (this.playing) {
        const counter = sec.bars ? `${pad2(sec.bar)}/${pad2(sec.bars)}` : '';
        H.left = `${(sec.name || sec.id || 'play').toUpperCase()} ${counter}`;
        H.right = this.chord.symbol;
        H.roman = this.chord.roman;
      } else {
        const parts = [
          this.mood,
          typeof this.song?.key === 'string' ? this.song.key : '',
          this.song ? `${this.song.bpm} bpm` : '',
        ];
        H.left = parts.filter(Boolean).join(' · ').toUpperCase() || 'READY';
        H.right = '';
        H.roman = '';
      }
      ctx.font = H.font;
      H.leftW = ctx.measureText(H.left).width;
      H.romanW = H.roman ? ctx.measureText(H.roman).width : 0;
    }
    const pad = Math.round(fs * 0.85);
    const y = Math.round(h - pad);
    ctx.font = H.font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = this.pal.inkCss;
    ctx.globalAlpha = 0.72;
    ctx.fillText(H.left, pad, y);
    if (this.playing) {
      const sz = Math.max(4, Math.round(fs * 0.3));
      let x = Math.round(pad + H.leftW + fs * 0.5);
      for (let i = 0; i < 4; i++) {
        const on = i === this.beatIndex;
        ctx.globalAlpha = on ? 0.95 : 0.2;
        ctx.fillStyle = on ? this.pal.accentCss : this.pal.inkCss;
        ctx.fillRect(x, Math.round(y - fs * 0.5), sz, sz);
        x += Math.round(sz * 1.7);
      }
    }
    if (H.right) {
      ctx.textAlign = 'right';
      let x = w - pad;
      if (H.roman) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = this.pal.inkCss;
        ctx.fillText(H.roman, x, y);
        x -= H.romanW + fs * 0.4;
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = this.pal.accentCss;
      ctx.fillText(H.right, x, y);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }

  // LCD scanlines and a vignette, painted once per size and theme.
  _overlay() {
    const c = this.canvas;
    const key = `${c.width}x${c.height}|${this.inkVer}`;
    if (this.overlay && key === this.overlayKey) return this.overlay;
    this.overlayKey = key;
    const o = (this.overlay ??= document.createElement('canvas'));
    o.width = c.width;
    o.height = c.height;
    const g = o.getContext('2d');
    const W = o.width;
    const H = o.height;
    g.fillStyle = this.dark ? 'rgba(0,0,0,0.2)' : css(this.ink, 0.04);
    const pitch = Math.max(3, Math.round(this.scale * 1.5));
    for (let y = 0; y < H; y += pitch) g.fillRect(0, y, W, Math.max(1, Math.round(this.scale * 0.5)));
    const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    grad.addColorStop(0, this.dark ? 'rgba(0,0,0,0)' : css(this.ink, 0));
    grad.addColorStop(1, this.dark ? 'rgba(0,0,0,0.55)' : css(this.ink, 0.1));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    return o;
  }

  // Note lifetime helper for scenes: 0..1 progress, or -1 when not visible.
  noteProgress(i, t, life) {
    const age = t - this.notes.born[i];
    if (age < -0.05 || age > life) return -1;
    return Math.max(0, age) / life;
  }
}

// --- scenes -------------------------------------------------------------------
//
// Each scene has hit(v, event, t) to spawn things for an event and
// draw(v, ctx, w, h, t, dt). Scene state lives in v.state[name].

const freqBand = (midi) => {
  const f = 440 * 2 ** ((midi - 69) / 12);
  return (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * BANDS - 0.5;
};

// A segmented LCD spectrum analyser with falling peak caps. Each vocal chop
// lights a marker over the column of its own pitch.
const spectrum = {
  geo(v, w, h) {
    const st = (v.state.spectrum ??= {
      w: 0,
      h: 0,
      s: 0,
      ver: -1,
      cache: null,
      xs: new Float32Array(48),
      lit: new Int16Array(48),
      cap: new Float32Array(48),
      capV: new Float32Array(48),
    });
    if (st.w === w && st.h === h && st.s === v.scale && st.ver === v.inkVer) return st;
    st.w = w;
    st.h = h;
    st.s = v.scale;
    st.ver = v.inkVer;
    st.cols = clamp(Math.round(w / 27), 12, 48);
    st.left = Math.round(w * 0.07);
    st.right = Math.round(w * 0.93);
    st.base = Math.round(h * 0.66);
    st.segH = clamp(Math.round(h * 0.022), 3, 16);
    st.gap = Math.max(1, Math.round(st.segH * 0.4));
    st.cell = st.segH + st.gap;
    st.nSeg = Math.max(4, Math.floor((st.base - Math.round(h * 0.12)) / st.cell));
    st.nRef = Math.max(2, Math.floor((h * 0.14) / st.cell));
    const pitch = (st.right - st.left) / st.cols;
    st.cw = Math.max(2, Math.floor(pitch * 0.72));
    for (let c = 0; c < st.cols; c++) st.xs[c] = Math.round(st.left + c * pitch + (pitch - st.cw) / 2);
    st.font = `${Math.round(clamp(st.segH * 2.2, 13, 28))}px ${v.fontLcd}`;
    st.cap.fill(0);
    st.capV.fill(0);

    // the unlit cells never change, so they're painted once
    const cache = (st.cache ??= document.createElement('canvas'));
    cache.width = v.canvas.width;
    cache.height = v.canvas.height;
    const g = cache.getContext('2d');
    g.setTransform(v.scale, 0, 0, v.scale, 0, 0);
    g.fillStyle = v.pal.inkCss;
    g.globalAlpha = v.dark ? 0.075 : 0.085;
    g.beginPath();
    for (let c = 0; c < st.cols; c++) {
      for (let s = 0; s < st.nSeg; s++) g.rect(st.xs[c], st.base - (s + 1) * st.cell + st.gap, st.cw, st.segH);
    }
    g.fill();
    return st;
  },

  // The word as a dot-matrix of cells, shown while nothing plays (like the
  // patch name on a sampler's screen). Rebuilt only when the word changes.
  mask(v, st) {
    if (st.maskVer === v.textVer && st.maskRows === st.nSeg) return;
    st.maskVer = v.textVer;
    st.maskRows = st.nSeg;
    const text = v.label;
    const rows = st.nSeg;
    const m = v.measure;
    m.font = `900 ${Math.round(rows * 0.85)}px ${v.fontUi}`;
    const width = clamp(Math.ceil(m.measureText(text).width) + 2, 1, 600);
    const c = (st.maskCanvas ??= document.createElement('canvas'));
    c.width = width;
    c.height = rows;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.font = m.font;
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(text, 1, rows / 2 + 0.5);
    const data = g.getImageData(0, 0, width, rows).data;
    st.mask = new Uint8Array(width * rows);
    st.maskFirst = width;
    st.maskLast = -1;
    for (let x = 0; x < width; x++) {
      for (let r = 0; r < rows; r++) {
        if (data[(r * width + x) * 4 + 3] < 110) continue;
        st.mask[x * rows + (rows - 1 - r)] = 1;
        st.maskFirst = Math.min(st.maskFirst, x);
        st.maskLast = Math.max(st.maskLast, x);
      }
    }
    st.maskW = width;
  },

  leave(v) {
    const st = v.state.spectrum;
    if (st?.cache) {
      st.cache.width = st.cache.height = 0;
      st.w = 0;
    }
  },

  col(st, midi) {
    const bf = freqBand(midi);
    return clamp(Math.round((bf / ((BANDS - 1) * 0.94)) * (st.cols - 1)), 0, st.cols - 1);
  },

  hit(v, q) {
    const st = v.state.spectrum;
    if (!st?.cols) return;
    const k = v.k;
    if (q.type === 'vox') {
      const c = spectrum.col(st, q.midi);
      const x = st.xs[c] + st.cw / 2;
      const y = st.base - (0.32 + 0.6 * q.pn) * st.nSeg * st.cell;
      const up = v.feel.lift < 0 ? -0.3 : 1;
      for (let j = 0; j < 7; j++) {
        const vx = (Math.random() - 0.5) * 140 * k;
        const vy = -(50 + Math.random() * 110) * k * up;
        v.sparks.spawn(
          x,
          y,
          vx,
          vy,
          0.45 + Math.random() * 0.4,
          Math.max(2, 3 * k),
          PIXEL,
          j % 3 ? ACCENT2 : INK,
          240 * k * up,
          1.5,
        );
      }
    } else if (q.type === 'hat') {
      const c = (Math.random() * st.cols) | 0;
      const y = st.base - (Math.max(1, st.lit[c]) + 1.5) * st.cell;
      v.sparks.spawn(st.xs[c] + st.cw / 2, y, 0, -25 * k, 0.28, (3 + 4 * q.vel) * k, TWINKLE, INK);
    } else if (q.type === 'impact') {
      for (let c = 0; c < st.cols; c++) {
        st.cap[c] = st.nSeg;
        st.capV[c] = -st.nSeg * 0.8;
      }
      for (let j = 0; j < 60; j++) {
        const x = st.left + Math.random() * (st.right - st.left);
        const vy = -(220 + Math.random() * 520) * k;
        v.sparks.spawn(
          x,
          st.base,
          (Math.random() - 0.5) * 120 * k,
          vy,
          1.2,
          Math.max(2, 3 * k),
          PIXEL,
          j % 4 ? ACCENT : INK,
          650 * k,
        );
      }
    }
  },

  draw(v, ctx, w, h, t, dt) {
    const st = spectrum.geo(v, w, h);
    const { cols, nSeg, nRef, cell, segH, gap, cw, base, left, right, xs } = st;
    const P = v.pal;
    ctx.drawImage(st.cache, 0, 0, w, h);
    // the snare lights the whole grid of unlit cells a little
    if (v.snare > 0.03) {
      ctx.globalAlpha = Math.min(1, v.snare * 0.9);
      ctx.drawImage(st.cache, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    const gain = (0.42 + 0.42 * v.energy) * (1 - 0.6 * v.hold);
    const fallAcc = nSeg * 2.2 * v.feel.fall;
    for (let c = 0; c < cols; c++) {
      const bf = (c / (cols - 1)) * (BANDS - 1) * 0.94;
      const b0 = bf | 0;
      const b1 = Math.min(BANDS - 1, b0 + 1);
      let lvl = v.spec[b0] + (v.spec[b1] - v.spec[b0]) * (bf - b0);
      lvl *= gain * (1 + 0.4 * v.kick * v.punch * (1 - c / cols));
      const lit = Math.min(nSeg, Math.round(lvl * nSeg));
      st.lit[c] = lit;
      if (lit >= st.cap[c]) {
        st.cap[c] = lit;
        st.capV[c] = 0;
      } else {
        st.capV[c] += fallAcc * dt;
        st.cap[c] = clamp(st.cap[c] - st.capV[c] * dt, lit, nSeg);
      }
    }

    // lit cells: accent, with the top quarter in the second accent (the "red zone")
    const hot = Math.max(2, Math.floor(nSeg * 0.74));
    ctx.fillStyle = P.accentCss;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const n = Math.min(st.lit[c], hot);
      if (n > 0) ctx.rect(xs[c], base - n * cell, cw, n * cell);
    }
    ctx.fill();
    ctx.fillStyle = P.accent2Css;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const n = st.lit[c];
      if (n > hot) ctx.rect(xs[c], base - n * cell, cw, (n - hot) * cell);
    }
    ctx.fill();
    // reflection under the baseline
    ctx.globalAlpha = v.dark ? 0.15 : 0.12;
    ctx.fillStyle = P.accentCss;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const n = Math.min(st.lit[c], nRef);
      if (n > 0) ctx.rect(xs[c], base + gap, cw, n * cell);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    // cut the gaps between cells back out
    ctx.fillStyle = P.bgCss;
    ctx.beginPath();
    for (let s = 1; s <= nSeg; s++) ctx.rect(left, base - s * cell, right - left, gap);
    for (let s = 0; s < nRef; s++) ctx.rect(left, base + gap + s * cell + segH, right - left, gap);
    ctx.fill();

    // at rest the screen spells out the word, scrolling if it doesn't fit
    const rest = 1 - v.live;
    if (rest > 0.02) {
      spectrum.mask(v, st);
      const span = st.maskLast - st.maskFirst + 1;
      if (span > 0) {
        let off = Math.floor((cols - span) / 2) - st.maskFirst;
        if (span > cols - 2) {
          // too wide: scroll like a marquee (a still frame shows the start)
          const travel = v.settling ? cols - 1 : Math.floor(fract((t * 5 * v.calm) / (span + cols)) * (span + cols));
          off = cols - travel - st.maskFirst;
        }
        ctx.fillStyle = P.inkCss;
        ctx.globalAlpha = 0.92 * rest;
        ctx.beginPath();
        for (let c = 0; c < cols; c++) {
          const x = c - off;
          if (x < 0 || x >= st.maskW) continue;
          for (let s = 0; s < nSeg; s++) {
            if (st.mask[x * nSeg + s]) ctx.rect(xs[c], base - (s + 1) * cell + gap, cw, segH);
          }
        }
        ctx.fill();
      }
    }

    // peak caps
    ctx.fillStyle = P.inkCss;
    ctx.globalAlpha = 0.85 * v.live;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const s = Math.min(nSeg - 1, Math.floor(st.cap[c]));
      if (st.cap[c] >= 1) ctx.rect(xs[c], base - (s + 1) * cell + gap, cw, segH);
    }
    ctx.fill();

    // bloom over the tops of lit columns on dark screens
    if (v.dark) {
      ctx.globalCompositeOperation = 'lighter';
      for (let c = 0; c < cols; c++) {
        const lit = st.lit[c];
        if (lit < 2) continue;
        const a = lit / nSeg;
        const s = cw * (2.2 + 3 * a);
        ctx.globalAlpha = 0.16 * a * (0.5 + 0.5 * v.energy);
        ctx.drawImage(v.glow[ACCENT], xs[c] + cw / 2 - s / 2, base - lit * cell - s / 2, s, s);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.globalAlpha = 0.35 + 0.5 * v.kick;
    ctx.fillStyle = P.accentCss;
    ctx.fillRect(left, base + Math.floor(gap / 2), right - left, 1);

    // the build: a dashed ceiling climbing toward the drop
    if (v.tension > 0.01) {
      const y = Math.round(base - v.tension * nSeg * cell) + 0.5;
      ctx.globalAlpha = 0.55 * Math.min(1, v.tension * 4);
      ctx.strokeStyle = P.inkCss;
      ctx.lineWidth = 1;
      ctx.setLineDash(v.dash);
      ctx.lineDashOffset = -t * 30;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.fillStyle = P.accentCss;
      ctx.beginPath();
      ctx.moveTo(left - 10, y - 5);
      ctx.lineTo(left - 3, y);
      ctx.lineTo(left - 10, y + 5);
      ctx.moveTo(right + 10, y - 5);
      ctx.lineTo(right + 3, y);
      ctx.lineTo(right + 10, y + 5);
      ctx.fill();
    }

    // vocal chops: a marker over the column of that pitch, labelled with the word
    const N = v.notes;
    const label = v.word ? v.label : '';
    const warp = v.feel.motion === 'warp';
    // only the newest chop gets a label, so they don't pile up
    let newest = -1;
    for (let i = 0; i < MAX_NOTES; i++) if (newest < 0 || N.born[i] > N.born[newest]) newest = i;
    ctx.font = st.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < MAX_NOTES; i++) {
      const life = clamp(0.6 + N.dur[i] * 2, 0.7, 2.4);
      const p = v.noteProgress(i, t, life);
      if (p < 0) continue;
      const age = p * life;
      const c = spectrum.col(st, N.midi[i]);
      const x = xs[c] + cw / 2;
      const y0 = base - (0.32 + 0.6 * N.pn[i]) * nSeg * cell;
      const y = warp ? y0 - nSeg * cell * 0.1 * (1 - Math.exp(-age * 7)) : y0 - v.feel.lift * age * nSeg * cell * 0.12;
      const a = (1 - p) ** 1.4 * (0.45 + 0.55 * N.vel[i]);
      const top = base - st.lit[c] * cell;
      ctx.fillStyle = P.inkCss;
      if (y < top) {
        ctx.globalAlpha = a * 0.35;
        ctx.fillRect(Math.round(x), y, 1, top - y);
      }
      ctx.globalAlpha = a;
      ctx.fillRect(xs[c] - 1, Math.round(y - segH / 2), cw + 2, segH);
      if (i === newest && p < 0.8) ctx.fillText(label || MIDI_NAMES[N.midi[i] | 0] || '', x, y - segH);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  },
};

// A record: the waveform as a ring, the spectrum as spokes, the word on the
// label. Kicks send out shockwaves; chops orbit at a radius set by pitch.
const orbit = {
  ring(ctx, cx, cy, wave, radius, amp) {
    const M = 120;
    ctx.beginPath();
    for (let i = 0; i <= M; i++) {
      const j = i <= M / 2 ? i : M - i;
      const val = wave[((j / (M / 2)) * (WAVE - 1)) | 0];
      const a = -Math.PI / 2 + (i / M) * TAU;
      const r = radius * (1 + val * amp);
      if (i) ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
  },

  hit(v, q, t) {
    const st = v.state.orbit;
    if (!st) return;
    const { cx, cy, R } = st;
    const k = v.k;
    if (q.type === 'kick') {
      v.rings.spawn(cx, cy, R * 1.1, R * 1.95, t, 0.55, 2.2 * k, 0.55 * q.vel * (0.5 + 0.5 * v.energy), ACCENT);
    } else if (q.type === 'snare') {
      for (let j = 0; j < 14; j++) {
        const a = Math.random() * TAU;
        const sp = (90 + Math.random() * 120) * k;
        v.sparks.spawn(
          cx + Math.cos(a) * R * 1.15,
          cy + Math.sin(a) * R * 1.15,
          Math.cos(a) * sp,
          Math.sin(a) * sp,
          0.4,
          Math.max(2, 2.5 * k),
          PIXEL,
          INK,
          0,
          2,
        );
      }
    } else if (q.type === 'hat') {
      const a = Math.random() * TAU;
      v.sparks.spawn(
        cx + Math.cos(a) * R * 2.05,
        cy + Math.sin(a) * R * 2.05,
        0,
        0,
        0.25,
        (3 + 4 * q.vel) * k,
        TWINKLE,
        INK,
      );
    } else if (q.type === 'vox') {
      const ro = R * (1.28 + 0.62 * q.pn);
      const a = q.seed * TAU;
      for (let j = 0; j < 8; j++) {
        const b = Math.random() * TAU;
        const sp = (40 + Math.random() * 90) * k;
        v.sparks.spawn(
          cx + Math.cos(a) * ro,
          cy + Math.sin(a) * ro,
          Math.cos(b) * sp,
          Math.sin(b) * sp,
          0.6,
          5 * k,
          GLOW,
          ACCENT2,
          0,
          2.5,
        );
      }
    } else if (q.type === 'impact') {
      for (let j = 0; j < 3; j++)
        v.rings.spawn(
          cx,
          cy,
          R * 0.6,
          R * (2.6 + j * 0.7),
          t + j * 0.08,
          0.9 + j * 0.2,
          4 * k,
          0.7,
          j === 1 ? ACCENT2 : ACCENT,
        );
      for (let j = 0; j < 70; j++) {
        const a = Math.random() * TAU;
        const sp = (200 + Math.random() * 500) * k;
        const kind = j % 3 ? STREAK : GLOW;
        v.sparks.spawn(
          cx + Math.cos(a) * R,
          cy + Math.sin(a) * R,
          Math.cos(a) * sp,
          Math.sin(a) * sp,
          0.9,
          kind === GLOW ? 6 * k : 1.5 * k,
          kind,
          j % 2 ? ACCENT : ACCENT2,
          0,
          1.6,
        );
      }
    }
  },

  draw(v, ctx, w, h, t, dt) {
    const st = (v.state.orbit ??= { cx: 0, cy: 0, R: 1, acc: 0, font: '', textVer: -1, lr: 0 });
    const P = v.pal;
    const k = v.k;
    const cx = w / 2;
    const cy = h * 0.47;
    const R0 = Math.min(w, h) * 0.2;
    const R = R0 * (1 + 0.08 * v.kick * v.punch + 0.04 * v.beatEnv * v.energy - 0.12 * v.hold + 0.1 * v.impact ** 2);
    st.cx = cx;
    st.cy = cy;
    st.R = R;

    // guide circles and a slowly turning dial of ticks
    ctx.strokeStyle = P.inkCss;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy, R0 * 2.05, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    const turn = -v.spin * 0.25;
    for (let i = 0; i < 60; i++) {
      const a = turn + (i / 60) * TAU;
      const r0 = R0 * 2.12;
      const r1 = r0 + (i % 5 ? 4 : 10) * k;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(cx + c * r0, cy + s * r0);
      ctx.lineTo(cx + c * r1, cy + s * r1);
    }
    ctx.stroke();

    // spectrum spokes, mirrored so the picture stays balanced
    const n = 96;
    ctx.globalAlpha = v.dark ? 0.5 : 0.55;
    ctx.lineWidth = Math.max(1.5, R * 0.02);
    ctx.lineCap = 'round';
    const spokeLen = R * 0.55 * (0.35 + 0.75 * v.energy);
    const r0 = R * 1.16;
    for (let pass = 0; pass < 2; pass++) {
      // second pass: the loud ones get an accent tip
      ctx.strokeStyle = pass ? P.accentCss : P.inkCss;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const m = i < n / 2 ? i : n - 1 - i;
        const lvl = v.spec[((m / (n / 2)) * BANDS * 0.85) | 0];
        const len = R * 0.03 + lvl * spokeLen;
        if (pass && lvl < 0.45) continue;
        const a = v.spin + (i / n) * TAU;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const from = pass ? r0 + len * 0.62 : r0;
        ctx.moveTo(cx + c * from, cy + s * from);
        ctx.lineTo(cx + c * (r0 + len), cy + s * (r0 + len));
      }
      ctx.globalAlpha = pass ? 0.9 : v.dark ? 0.5 : 0.55;
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.strokeStyle = P.inkCss;

    // vinyl grooves
    ctx.globalAlpha = 0.06;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const r = R * (0.55 + i * 0.1);
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, TAU);
    }
    ctx.stroke();

    // the waveform ring, mirrored left/right so it closes without a seam, and
    // a fainter copy from a moment ago like phosphor
    const amp = 0.26 * (0.35 + 0.8 * v.energy);
    orbit.ring(ctx, cx, cy, v.hist[(v.histIdx + HISTORY - 2) % HISTORY], R * 0.93, amp);
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = P.accent2Css;
    ctx.lineWidth = 1;
    ctx.stroke();
    orbit.ring(ctx, cx, cy, v.wave, R, amp);
    ctx.globalAlpha = v.dark ? 0.08 : 0.12;
    ctx.fillStyle = P.accentCss;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = P.accentCss;
    ctx.lineWidth = Math.max(2, R * 0.025);
    ctx.lineJoin = 'round';
    ctx.stroke();

    // the label: the word on an accent disc, turning with the record
    const lr = R * 0.42 * (1 + 0.05 * v.kick * v.punch);
    ctx.fillStyle = P.accentCss;
    ctx.beginPath();
    ctx.arc(cx, cy, lr, 0, TAU);
    ctx.fill();
    if (v.snare > 0.05) {
      ctx.globalAlpha = v.snare * 0.7;
      ctx.strokeStyle = P.inkCss;
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.arc(cx, cy, lr * 1.12, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const text = v.label;
    const lr0 = R0 * 0.42;
    if (st.textVer !== v.textVer || st.lr !== lr0) {
      st.textVer = v.textVer;
      st.lr = lr0;
      v.measure.font = `800 100px ${v.fontUi}`;
      const tw = Math.max(1, v.measure.measureText(text).width);
      st.font = `800 ${Math.max(6, Math.min(lr0 * 0.42, (100 * lr0 * 1.45) / tw)).toFixed(1)}px ${v.fontUi}`;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(v.spin * 0.35);
    ctx.font = st.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = P.bgCss;
    ctx.fillText(text, 0, 0);
    ctx.beginPath();
    ctx.arc(0, -lr * 0.62, Math.max(1.5, lr * 0.06), 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.textAlign = 'left';

    // vocal chops orbit; higher notes swing wider
    const N = v.notes;
    const f = v.feel;
    for (let i = 0; i < MAX_NOTES; i++) {
      const life = clamp(0.9 + N.dur[i] * 2.4, 1, 3);
      const p = v.noteProgress(i, t, life);
      if (p < 0) continue;
      const age = p * life;
      let ro = R * (1.28 + 0.62 * N.pn[i]);
      if (f.motion === 'rain') ro *= 1 - 0.3 * p;
      else if (f.motion === 'bokeh') ro *= 1 + 0.15 * p;
      const dir = N.seed[i] > 0.5 ? 1 : -1;
      const omega = (1.1 + N.vel[i]) * (0.5 + 0.6 * f.pace) * v.calm * dir;
      const a = N.seed[i] * TAU + omega * age;
      const trail = Math.min(1.3, Math.abs(omega) * age * 0.9 + 0.05);
      const fade = (1 - p) ** 1.2;
      ctx.globalAlpha = fade * 0.8;
      ctx.strokeStyle = P.accent2Css;
      ctx.lineWidth = (1.5 + 2.5 * N.vel[i]) * k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, ro, dir > 0 ? a - trail : a, dir > 0 ? a : a + trail);
      ctx.stroke();
      ctx.lineCap = 'butt';
      const x = cx + Math.cos(a) * ro;
      const y = cy + Math.sin(a) * ro;
      const g = (12 + 14 * N.vel[i]) * k;
      if (v.dark) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fade;
      ctx.drawImage(v.glow[ACCENT2], x - g, y - g, g * 2, g * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = P.inkCss;
      ctx.beginPath();
      ctx.arc(x, y, 2.4 * k, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // the build pulls streaks into the centre, faster as the drop gets close
    st.acc += v.tension * (1 - v.hold) * 60 * dt * v.calm;
    while (st.acc >= 1) {
      st.acc -= 1;
      const a = Math.random() * TAU;
      const r = R0 * 2.3;
      const sp = R0 * (1.1 + 2.4 * v.tension);
      v.sparks.spawn(
        cx + Math.cos(a) * r,
        cy + Math.sin(a) * r,
        -Math.cos(a) * sp,
        -Math.sin(a) * sp,
        (r - R0 * 0.6) / sp,
        1.5 * k,
        STREAK,
        ACCENT,
      );
    }
  },
};

// A synthwave horizon: sun over a scrolling grid, a skyline made of the
// spectrum, stars that twinkle on the hats and chops that light up as new
// stars at the height of their pitch. Sad gets a moon and rain, dreamy a soft
// orb and drifting motes.
const horizon = {
  init() {
    const rnd = seeded(7);
    const stars = 110;
    const drops = 150;
    const st = {
      rise: 0.6,
      stars,
      sx: new Float32Array(stars),
      sy: new Float32Array(stars),
      ss: new Float32Array(stars),
      sp: new Float32Array(stars),
      sf: new Float32Array(stars),
      drops,
      dx: new Float32Array(drops),
      dy: new Float32Array(drops),
      dz: new Float32Array(drops),
      ver: -1,
      sunVer: -1,
    };
    for (let i = 0; i < stars; i++) {
      st.sx[i] = rnd();
      st.sy[i] = rnd() ** 1.3;
      st.ss[i] = rnd() ** 2;
      st.sp[i] = rnd() * 3;
    }
    for (let i = 0; i < drops; i++) {
      st.dx[i] = rnd();
      st.dy[i] = rnd();
      st.dz[i] = 0.25 + 0.75 * rnd();
    }
    return st;
  },

  leave(v) {
    const st = v.state.horizon;
    if (st?.layer) {
      st.layer.width = st.layer.height = 0;
      st.w = 0;
    }
  },

  // Where a chop's star sits (written to PT to keep the frame allocation-free).
  starAt(v, w, h, hy, seed, pn, age) {
    PT[0] = w * (0.06 + 0.88 * seed);
    PT[1] = hy * (0.86 - 0.74 * pn);
    if (v.feel.motion === 'warp') PT[0] += (seed > 0.5 ? 1 : -1) * age * w * 0.18 * v.calm;
    else PT[1] -= v.feel.lift * age * h * 0.045 * v.calm;
  },

  hit(v, q, t) {
    const st = v.state.horizon;
    if (!st) return;
    const { w, h, k } = v;
    const hy = Math.round(h * 0.6);
    const sunR = Math.min(w * 0.2, h * 0.3);
    const sunX = w / 2;
    if (q.type === 'hat') {
      for (let j = 0; j < 4; j++) st.sf[(Math.random() * st.stars) | 0] = q.vel;
    } else if (q.type === 'vox') {
      horizon.starAt(v, w, h, hy, q.seed, q.pn, 0);
      const x = PT[0];
      const y = PT[1];
      for (let j = 0; j < 6; j++) {
        const a = Math.random() * TAU;
        const sp = (30 + Math.random() * 60) * k;
        v.sparks.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.6, Math.max(2, 2.5 * k), PIXEL, ACCENT2, 0, 2);
      }
    } else if (q.type === 'impact') {
      const sunY = hy - st.rise * sunR;
      v.rings.spawn(sunX, sunY, sunR, sunR * 2.6, t, 0.9, 3 * k, 0.6, ACCENT);
      for (let j = 0; j < 70; j++) {
        const x = Math.random() * w;
        v.sparks.spawn(
          x,
          hy,
          (Math.random() - 0.5) * 160 * k,
          -(150 + Math.random() * 420) * k,
          1.3,
          Math.max(2, 3 * k),
          PIXEL,
          j % 3 ? ACCENT : ACCENT2,
          520 * k,
        );
      }
    }
  },

  draw(v, ctx, w, h, t, dt) {
    const st = (v.state.horizon ??= horizon.init());
    const P = v.pal;
    const k = v.k;
    const f = v.feel;
    const hy = Math.round(h * 0.6);
    const sunR0 = Math.min(w * 0.2, h * 0.3);
    const sunX = w / 2;
    const floorH = h - hy;

    // the sun sits low in the intro, climbs through the build, sets in the outro
    const sid = v.playing ? v.sec.id : 'idle';
    const p = v.sec.progress;
    let rise = 0.62;
    if (sid === 'intro') rise = 0.3 + 0.15 * p;
    else if (sid === 'build') rise = 0.45 + 0.4 * p;
    else if (sid === 'drop') rise = 0.92;
    else if (sid === 'outro') rise = 0.85 - 0.7 * p;
    st.rise = v.settling ? rise : ease(st.rise, rise, 1.2, dt);
    const sunR = sunR0 * (f.motion === 'rain' ? 0.8 : 1) * (1 + 0.035 * v.kick * v.punch + 0.05 * v.impact);
    const sunY = hy + sunR0 * 0.2 - st.rise * sunR0 * 1.05;

    // the sky (background, a glow of the accent toward the horizon, far hills)
    // only changes with size and colour, so it's painted once and blitted
    const hueKey = Math.round(v.palShift / 5);
    if (st.w !== w || st.h !== h || st.s !== v.scale || st.ver !== v.inkVer || st.hue !== hueKey) {
      st.w = w;
      st.h = h;
      st.s = v.scale;
      st.ver = v.inkVer;
      st.hue = hueKey;
      const layer = (st.layer ??= document.createElement('canvas'));
      layer.width = v.canvas.width;
      layer.height = v.canvas.height;
      const g = layer.getContext('2d', { alpha: false });
      g.setTransform(v.scale, 0, 0, v.scale, 0, 0);
      g.fillStyle = P.bgCss;
      g.fillRect(0, 0, w, h);
      const sky = g.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, css(v.accent, 0));
      sky.addColorStop(0.55, css(v.accent, v.dark ? 0.035 : 0.025));
      sky.addColorStop(1, css(v.accent, v.dark ? 0.17 : 0.12));
      g.fillStyle = sky;
      g.fillRect(0, 0, w, hy);
      // the sun's glow, baked in low over the horizon
      const glow = g.createRadialGradient(sunX, hy, 0, sunX, hy, sunR0 * 2.6);
      glow.addColorStop(0, css(v.accent, v.dark ? 0.3 : 0.16));
      glow.addColorStop(0.45, css(v.accent, v.dark ? 0.1 : 0.06));
      glow.addColorStop(1, css(v.accent, 0));
      g.fillStyle = glow;
      g.fillRect(sunX - sunR0 * 2.6, hy - sunR0 * 2.6, sunR0 * 5.2, sunR0 * 2.6);
      g.fillStyle = P.inkCss;
      g.globalAlpha = v.dark ? 0.07 : 0.08;
      g.beginPath();
      g.moveTo(0, hy);
      for (let i = 0; i <= 40; i++) {
        const u = (i / 40) * 6;
        const y =
          hy - h * (0.05 + 0.035 * Math.sin(u * 1.7 + 1) + 0.025 * Math.sin(u * 3.1 + 2) + 0.012 * Math.sin(u * 7.3));
        g.lineTo((i / 40) * w, y);
      }
      g.lineTo(w, hy);
      g.fill();
    }
    if (st.sunVer !== v.palVer) {
      st.sunVer = v.palVer;
      st.sun = ctx.createLinearGradient(0, -1, 0, 1);
      st.sun.addColorStop(0, P.accent2Css);
      st.sun.addColorStop(0.75, P.accentCss);
    }
    ctx.drawImage(st.layer, 0, 0, w, h);

    // stars
    ctx.fillStyle = P.inkCss;
    const decay = Math.exp(-5 * dt);
    for (let i = 0; i < st.stars; i++) {
      st.sf[i] *= decay;
      const tw = 0.5 + 0.5 * Math.sin(t * (0.6 + st.sp[i]) + st.sp[i] * 40);
      const y = st.sy[i] * hy * 0.94;
      const a = (0.12 + 0.4 * tw * st.ss[i] + 0.7 * st.sf[i]) * (1 - (y / hy) * 0.7);
      const s = (1 + st.ss[i] * 1.6 + st.sf[i] * 1.5) * Math.max(1, k * 0.8);
      ctx.globalAlpha = a * (v.dark ? 1 : 0.55);
      ctx.fillRect(Math.round(st.sx[i] * w), Math.round(y), s, s);
    }
    ctx.globalAlpha = 1;

    // sun (with an extra halo for the moment of the drop)
    if (v.dark && v.impact > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * v.impact;
      ctx.drawImage(v.glow[ACCENT], sunX - sunR * 1.6, sunY - sunR * 1.6, sunR * 3.2, sunR * 3.2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    ctx.translate(sunX, sunY);
    ctx.scale(sunR, sunR);
    ctx.fillStyle = st.sun;
    ctx.globalAlpha = f.motion === 'bokeh' ? 0.88 : 1;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    if (f.motion === 'rain') {
      // a crescent moon, with the dark side still faintly there
      ctx.save();
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR + 1, 0, TAU);
      ctx.clip();
      ctx.fillStyle = P.bgCss;
      ctx.beginPath();
      ctx.arc(sunX + sunR * 0.4, sunY - sunR * 0.18, sunR * 0.9, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = P.accentCss;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR, 0, TAU);
      ctx.stroke();
    } else if (f.motion === 'bokeh') {
      ctx.strokeStyle = P.accent2Css;
      ctx.lineWidth = 1.2 * k;
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.24 - i * 0.06;
        ctx.beginPath();
        ctx.arc(sunX, sunY, sunR * (1.18 + 0.17 * i + 0.04 * Math.sin(t * 0.8 + i)), 0, TAU);
        ctx.stroke();
      }
    } else {
      // slats that slide down the lower half
      ctx.fillStyle = P.bgCss;
      const slats = 7;
      const ph = fract(v.travel * 0.25);
      for (let j = 0; j < slats; j++) {
        const u = (j + ph) / slats;
        const y = sunY + sunR * (0.05 + u * 0.95);
        const th = sunR * (0.012 + 0.08 * u);
        ctx.fillRect(sunX - sunR - 1, y - th / 2, sunR * 2 + 2, th);
      }
    }
    ctx.globalAlpha = 1;

    // a near skyline made of the spectrum (bass at the edges)
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(0, hy);
    const m = 48;
    for (let i = 0; i <= m; i++) {
      const u = i / m;
      const d = Math.abs(u - 0.5) * 2;
      const lvl = v.spec[((1 - d) * BANDS * 0.7) | 0];
      const shape = 0.5 + 0.5 * Math.sin(i * 1.9) * Math.sin(i * 0.7 + 1);
      const y =
        hy - h * (0.006 + d * 0.04 + lvl * (0.035 + 0.09 * v.energy) * (0.55 + 0.45 * shape) * (0.35 + 0.65 * d));
      ctx.lineTo(u * w, y);
    }
    ctx.lineTo(w, hy);
    ctx.fillStyle = P.bgCss;
    ctx.fill();
    ctx.strokeStyle = P.accentCss;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = Math.max(1, 1.3 * k);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;

    // the floor
    ctx.fillStyle = P.bgCss;
    ctx.fillRect(0, hy, w, floorH + 2);
    ctx.fillStyle = P.accentCss;
    const ripple = fract(v.travel * 0.5);
    for (let j = 0; j < 10; j++) {
      const u = (j + ripple) / 10;
      const y = hy + floorH * u ** 1.7;
      const ww = sunR * (1.15 - 0.6 * u) * (0.85 + 0.15 * Math.sin(t * 2 + j));
      ctx.globalAlpha = 0.18 * (1 - u) * st.rise;
      ctx.fillRect(sunX - ww / 2, y, ww, Math.max(1, 1.5 * k));
    }
    // the grid fades into the distance in a few alpha steps (a gradient
    // stroke would look the same but costs far more without a GPU)
    const gridA = 0.5 + 0.4 * v.energy + 0.1 * v.kick;
    ctx.strokeStyle = P.accentCss;
    ctx.lineWidth = Math.max(1, k * (0.9 + 0.8 * v.kick * v.punch));
    const zf = fract(v.travel);
    for (let i = 0; i < 28; i++) {
      const y = hy + (floorH * 0.85) / (i + 1 - zf);
      if (y > h + 2) continue;
      if (y - hy < 1.2) break;
      ctx.globalAlpha = gridA * gridFade((y - hy) / floorH);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const span = Math.max(w, h * 1.2) * 0.13;
    for (let b = 0; b < GRID_BANDS.length - 1; b++) {
      const d0 = GRID_BANDS[b];
      const d1 = GRID_BANDS[b + 1];
      ctx.globalAlpha = gridA * gridFade((d0 + d1) / 2);
      ctx.beginPath();
      for (let j = -16; j <= 16; j++) {
        const top = sunX + j * span * 0.01;
        const dx = j * span - (top - sunX);
        ctx.moveTo(top + dx * d0, hy + 1 + (floorH - 1) * d0);
        ctx.lineTo(top + dx * d1, hy + 1 + (floorH - 1) * d1);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = P.accentCss;
    ctx.fillRect(0, hy - Math.max(0.5, 0.75 * k), w, Math.max(1, 1.5 * k));
    if (v.dark) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.3 + 0.3 * v.impact;
      ctx.drawImage(v.glow[ACCENT], -w * 0.1, hy - 12 * k, w * 1.2, 24 * k);
      ctx.globalCompositeOperation = 'source-over';
    }

    // weather
    if (f.motion === 'rain') {
      const fall = (0.5 + 0.6 * v.energy) * v.calm * dt;
      ctx.strokeStyle = P.inkCss;
      ctx.lineWidth = Math.max(1, k * 0.9);
      ctx.globalAlpha = v.dark ? 0.2 : 0.22;
      ctx.beginPath();
      for (let i = 0; i < st.drops; i++) {
        st.dy[i] += fall * (0.55 + 0.45 * st.dz[i]);
        if (st.dy[i] > 1.05) {
          st.dy[i] -= 1.1;
          st.dx[i] = Math.random();
        }
        const x = st.dx[i] * w * 1.1;
        const y = st.dy[i] * h;
        const len = (10 + 16 * st.dz[i]) * k;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * 0.18, y - len);
      }
      ctx.stroke();
    } else if (f.motion === 'bokeh') {
      if (v.dark) ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 40; i++) {
        st.dy[i] -= (0.02 + 0.03 * st.dz[i]) * (0.5 + v.energy) * v.calm * dt;
        if (st.dy[i] < -0.05) {
          st.dy[i] += 1.1;
          st.dx[i] = Math.random();
        }
        const x = (st.dx[i] + 0.02 * Math.sin(t * 0.4 + i)) * w;
        const s = (6 + 22 * st.dz[i]) * k;
        ctx.globalAlpha = (0.1 + 0.18 * st.dz[i]) * (v.dark ? 1 : 0.7);
        ctx.drawImage(v.bokeh[i % 2 ? ACCENT2 : ACCENT], x - s, st.dy[i] * h - s, s * 2, s * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // vocal chops: new stars, higher in the sky for higher notes
    const N = v.notes;
    const warp = f.motion === 'warp';
    for (let i = 0; i < MAX_NOTES; i++) {
      const life = clamp(0.8 + N.dur[i] * 2, 0.9, 2.6);
      const pp = v.noteProgress(i, t, life);
      if (pp < 0) continue;
      const age = pp * life;
      horizon.starAt(v, w, h, hy, N.seed[i], N.pn[i], age);
      const x = PT[0];
      const y = PT[1];
      const s = (6 + 16 * N.vel[i]) * k * Math.min(1, age * 14) * (1 - 0.35 * pp);
      const a = (1 - pp) ** 1.3;
      if (warp) {
        const dir = N.seed[i] > 0.5 ? 1 : -1;
        ctx.globalAlpha = a * 0.6;
        ctx.strokeStyle = P.accent2Css;
        ctx.lineWidth = Math.max(1, 1.5 * k);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - dir * Math.min(age, 0.3) * w * 0.18 * v.calm, y);
        ctx.stroke();
      }
      if (v.dark) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.9;
      ctx.drawImage(v.glow[ACCENT2], x - s * 1.6, y - s * 1.6, s * 3.2, s * 3.2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = a;
      ctx.fillStyle = P.inkCss;
      const th = Math.max(1, 1.2 * k);
      ctx.fillRect(x - s, y - th / 2, s * 2, th);
      ctx.fillRect(x - th / 2, y - s, th, s * 2);
    }
    ctx.globalAlpha = 1;
  },
};

// Kinetic type: the word, huge, cut into horizontal slices that each chop
// knocks sideways at the height of its pitch. It fills with colour through
// the build, is full on the drop and drains in the outro.
const word = {
  state(v) {
    return (v.state.word ??= {
      w: 0,
      h: 0,
      s: 0,
      textVer: -1,
      inkVer: -1,
      hue: 1e9,
      ink: null,
      accent: null,
      outline: null,
      unit: null,
      bw: 0,
      bh: 0,
      n: 10,
      x: new Float32Array(16),
      vx: new Float32Array(16),
      fill: 0.4,
    });
  },

  leave(v) {
    const st = v.state.word;
    if (!st) return;
    for (const c of [st.ink, st.accent, st.outline, st.unit]) if (c) c.width = c.height = 0;
    st.w = 0;
  },

  build(v, st, w, h) {
    const text = v.label;
    const fresh = st.w !== w || st.h !== h || st.s !== v.scale || st.textVer !== v.textVer;
    const needInk = fresh || st.inkVer !== v.inkVer;
    if (!needInk && Math.abs(st.hue - v.palShift) <= 6) return;
    const s = v.scale;
    if (fresh) {
      const m = v.measure;
      m.font = `900 100px ${v.fontUi}`;
      if ('fontStretch' in m) m.fontStretch = 'expanded';
      const mt = m.measureText(text);
      if ('fontStretch' in m) m.fontStretch = 'normal';
      st.left = mt.actualBoundingBoxLeft || 0;
      st.asc = mt.actualBoundingBoxAscent || 72;
      const tw = Math.max(1, st.left + (mt.actualBoundingBoxRight || mt.width));
      const th = Math.max(1, st.asc + (mt.actualBoundingBoxDescent || 0));
      st.fs = Math.max(8, Math.min((100 * w * 0.84) / tw, (100 * h * 0.36) / th));
      st.pad = Math.ceil(st.fs * 0.06 + 2);
      st.bw = Math.ceil((tw * st.fs) / 100 + st.pad * 2);
      st.bh = Math.ceil((th * st.fs) / 100 + st.pad * 2);
      st.n = st.bh > 120 ? 10 : 6;
    }
    const paint = (canvas, stroke, color) => {
      canvas.width = Math.ceil(st.bw * s);
      canvas.height = Math.ceil(st.bh * s);
      const g = canvas.getContext('2d');
      g.setTransform(s, 0, 0, s, 0, 0);
      g.font = `900 ${st.fs}px ${v.fontUi}`;
      if ('fontStretch' in g) g.fontStretch = 'expanded';
      g.textBaseline = 'alphabetic';
      const x = st.pad + (st.left * st.fs) / 100;
      const y = st.pad + (st.asc * st.fs) / 100;
      if (stroke) {
        g.strokeStyle = color;
        g.lineWidth = Math.max(1.5, st.fs * 0.02);
        g.lineJoin = 'round';
        g.strokeText(text, x, y);
      } else {
        g.fillStyle = color;
        g.fillText(text, x, y);
      }
      return canvas;
    };
    if (needInk) {
      st.ink = paint(st.ink ?? document.createElement('canvas'), false, v.pal.inkCss);
      // one strip of the marquee rows behind the word, a tile wider than the
      // screen so each row is a single draw
      const strip = (st.unit ??= document.createElement('canvas'));
      const fs = Math.round(clamp(h * 0.075, 14, 72));
      const label = `${text} · `;
      v.measure.font = `${fs}px ${v.fontLcd}`;
      st.unitW = Math.max(8, Math.ceil(v.measure.measureText(label).width));
      st.unitH = Math.ceil(fs * 1.1);
      const tiles = Math.ceil(w / st.unitW) + 1;
      st.stripW = tiles * st.unitW;
      strip.width = Math.ceil(st.stripW * s);
      strip.height = Math.ceil(st.unitH * s);
      const g = strip.getContext('2d');
      g.setTransform(s, 0, 0, s, 0, 0);
      g.font = `${fs}px ${v.fontLcd}`;
      g.textBaseline = 'middle';
      g.fillStyle = v.pal.inkCss;
      for (let i = 0; i < tiles; i++) g.fillText(label, i * st.unitW, st.unitH / 2);
    }
    st.accent = paint(st.accent ?? document.createElement('canvas'), false, v.pal.accentCss);
    st.outline = paint(st.outline ?? document.createElement('canvas'), true, v.pal.accentCss);
    st.hue = v.palShift;
    st.w = w;
    st.h = h;
    st.s = s;
    st.textVer = v.textVer;
    st.inkVer = v.inkVer;
  },

  hit(v, q) {
    const st = v.state.word;
    if (!st?.bw) return;
    const amp = v.feel.chop * (v.reduced ? 0.12 : 1);
    const k = v.k;
    const cx = v.w / 2;
    const cy = v.h * 0.47;
    if (q.type === 'vox') {
      const ci = Math.round((1 - q.pn) * (st.n - 1));
      const dir = q.seed > 0.5 ? 1 : -1;
      for (let j = 0; j < st.n; j++) {
        st.vx[j] += dir * v.w * 1.1 * (0.4 + 0.6 * q.vel) * amp * Math.exp(-((j - ci) ** 2) / 1.5);
      }
    } else if (q.type === 'hat') {
      if (v.tension > 0.2) st.vx[(Math.random() * st.n) | 0] += (Math.random() - 0.5) * v.w * 1.4 * v.tension * amp;
      const x = cx + (Math.random() - 0.5) * st.bw;
      const y = cy + (Math.random() < 0.5 ? -1 : 1) * st.bh * (0.45 + Math.random() * 0.2);
      v.sparks.spawn(x, y, 0, 0, 0.3, (3 + 4 * q.vel) * k, TWINKLE, INK);
    } else if (q.type === 'impact') {
      for (let j = 0; j < st.n; j++) st.vx[j] += (Math.random() - 0.5) * v.w * 3 * amp;
      for (let j = 0; j < 60; j++) {
        const a = Math.random() * TAU;
        const sp = (160 + Math.random() * 420) * k;
        v.sparks.spawn(
          cx + Math.cos(a) * st.bw * 0.3,
          cy + Math.sin(a) * st.bh * 0.3,
          Math.cos(a) * sp,
          Math.sin(a) * sp,
          1,
          Math.max(2, 3 * k),
          PIXEL,
          j % 3 ? ACCENT : ACCENT2,
          200 * k,
          1.2,
        );
      }
    }
  },

  draw(v, ctx, w, h, t, dt) {
    const st = word.state(v);
    word.build(v, st, w, h);
    const P = v.pal;
    const f = v.feel;
    const k = v.k;
    const { bw, bh, n } = st;
    const cx = w / 2;
    let cy = h * 0.47;
    if (f.motion === 'bokeh') cy += Math.sin(t * 0.8) * h * 0.012 * v.calm;

    // marquee rows of the word drifting in opposite directions
    const rows = h > 260 ? 5 : 3;
    const rowH = h / rows;
    ctx.globalAlpha = (v.dark ? 0.06 : 0.07) * (0.6 + 0.6 * v.energy);
    for (let r = 0; r < rows; r++) {
      const dir = r % 2 ? 1 : -1;
      const off = fract(v.travel * 0.16 * (0.7 + 0.15 * r)) * st.unitW;
      const y = (r + 0.5) * rowH - st.unitH / 2;
      ctx.drawImage(st.unit, dir > 0 ? off - st.unitW : -off, y, st.stripW, st.unitH);
    }
    ctx.globalAlpha = 1;

    // fill level: empty in the intro, rising through the build, full on the drop
    const sid = v.playing ? v.sec.id : 'idle';
    const p = v.sec.progress;
    let fill = 0.5;
    if (sid === 'idle') fill = 0.42 + 0.05 * Math.sin(t * 0.7);
    else if (sid === 'intro') fill = 0.12 * p;
    else if (sid === 'build') fill = 0.12 + 0.88 * p;
    else if (sid === 'drop') fill = 1;
    else if (sid === 'outro') fill = 1 - 0.85 * p;
    st.fill = v.settling ? fill : ease(st.fill, fill, sid === 'drop' ? 8 : 2.5, dt);

    // slices spring back to rest (small fixed steps keep the spring stable)
    if (v.settling) {
      st.x.fill(0);
      st.vx.fill(0);
    } else {
      const K = f.spring;
      const D = 2 * Math.sqrt(K) * 0.3;
      for (let rem = dt; rem > 0; rem -= 1 / 120) {
        const step = Math.min(rem, 1 / 120);
        for (let j = 0; j < n; j++) {
          st.vx[j] += (-K * st.x[j] - D * st.vx[j]) * step;
          st.x[j] += st.vx[j] * step;
        }
      }
    }

    // each chop leaves an outline echo at the height of its pitch (the
    // newest few only: each one is a big image to blend)
    const N = v.notes;
    const grow = f.motion === 'bokeh' ? 0.5 : f.motion === 'rain' ? 0.18 : 0.32;
    for (let back = 0; back < 4; back++) {
      const i = (N.next - 1 - back + MAX_NOTES) % MAX_NOTES;
      const life = clamp(0.55 + N.dur[i] * 1.6, 0.6, 1.8);
      const pp = v.noteProgress(i, t, life);
      if (pp < 0) continue;
      const sc = 1 + grow * (1 - (1 - pp) ** 2);
      const yo = (0.5 - N.pn[i]) * h * 0.5 - f.lift * pp * life * h * 0.05 * v.calm;
      ctx.globalAlpha = (1 - pp) ** 2 * (0.3 + 0.45 * N.vel[i]) * (f.motion === 'bokeh' ? 0.7 : 1);
      ctx.drawImage(st.outline, cx - (bw * sc) / 2, cy + yo - (bh * sc) / 2, bw * sc, bh * sc);
    }
    ctx.globalAlpha = 1;

    const S = 1 + 0.07 * v.kick * v.punch + 0.25 * v.impact ** 4 * (v.reduced ? 0.3 : 1);
    const skew = v.reduced ? 0 : 0.1 * v.snare * v.punch;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(S, 0, -skew * S, S, 0, 0);
    const split = (v.kick * 7 + v.snare * 5) * k * v.punch;
    if (split > 1.5) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(st.outline, -bw / 2 + split, -bh / 2, bw, bh);
      ctx.globalAlpha = 1;
    }
    const iw = st.ink.width;
    const ih = st.ink.height;
    const sh = bh / n;
    const fy = bh * (1 - st.fill);
    for (let i = 0; i < n; i++) {
      const dx = st.x[i];
      const y0 = i * sh;
      ctx.drawImage(st.ink, 0, (y0 / bh) * ih, iw, ih / n, -bw / 2 + dx, -bh / 2 + y0, bw, sh + 0.5);
      if (y0 + sh > fy) {
        const a0 = Math.max(y0, fy);
        const srcH = ((y0 + sh - a0) / bh) * ih;
        if (srcH > 0.5)
          ctx.drawImage(st.accent, 0, (a0 / bh) * ih, iw, srcH, -bw / 2 + dx, -bh / 2 + a0, bw, y0 + sh - a0 + 0.5);
      }
    }
    // the level line, like liquid in a meter
    if (st.fill > 0.02 && st.fill < 0.98) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = P.accentCss;
      ctx.fillRect(-bw / 2 - 12 * k, -bh / 2 + fy - 0.75 * k, 8 * k, 1.5 * k);
      ctx.fillRect(bw / 2 + 4 * k, -bh / 2 + fy - 0.75 * k, 8 * k, 1.5 * k);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // a segmented level meter under the word, lit from the centre out
    const cells = 25;
    const mw = Math.min(bw * 0.7, w * 0.6);
    const cwid = mw / cells;
    const my = Math.round(cy + (bh / 2) * S + 12 * k);
    const mh = Math.max(3, Math.round(5 * k));
    const lvl = clamp((v.bass * 0.4 + v.mid * 0.45) * (0.4 + 0.5 * v.energy) + 0.3 * v.kick, 0, 1);
    const lit = lvl * (cells / 2 + 0.5);
    const x0 = cx - mw / 2;
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass ? P.accentCss : P.inkCss;
      ctx.globalAlpha = pass ? 0.95 : 0.1;
      ctx.beginPath();
      for (let c = 0; c < cells; c++) {
        const on = Math.abs(c - (cells - 1) / 2) < lit;
        if (on === Boolean(pass)) ctx.rect(Math.round(x0 + c * cwid), my, Math.max(1, Math.round(cwid * 0.7)), mh);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
};

// Particles and a silk ribbon of the waveform. Sad rains, dreamy floats up
// as bokeh, hype is a warp-speed starfield; chops hang as lanterns at the
// height of their pitch.
const drift = {
  seed(st, mode) {
    const rnd = seeded(11);
    for (let i = 0; i < st.n; i++) {
      st.x[i] = mode === 'warp' ? rnd() * 2 - 1 : rnd();
      st.y[i] = mode === 'warp' ? rnd() * 2 - 1 : rnd();
      st.z[i] = mode === 'warp' ? 0.05 + rnd() * 0.95 : 0.2 + 0.8 * rnd();
      st.ph[i] = rnd() * TAU;
    }
    st.mode = mode;
  },

  // Where a chop's lantern hangs (written to PT).
  lantern(v, w, h, seed, pn, age) {
    PT[0] = w * (0.1 + 0.8 * seed);
    PT[1] = h * 0.56 - (pn - 0.45) * h * 0.72 - v.feel.lift * age * h * 0.05 * v.calm;
    if (v.feel.motion === 'warp') PT[0] += (seed > 0.5 ? 1 : -1) * age * w * 0.05 * v.calm;
  },

  hit(v, q) {
    const { w, h, k } = v;
    if (q.type === 'vox') {
      drift.lantern(v, w, h, q.seed, q.pn, 0);
      const x = PT[0];
      const y = PT[1];
      const g = v.feel.lift * -60 * k;
      for (let j = 0; j < 10; j++) {
        const a = (j / 10) * TAU;
        const sp = (60 + Math.random() * 80) * k;
        v.sparks.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.9, 5 * k, GLOW, ACCENT, g, 2);
      }
    } else if (q.type === 'hat') {
      const x = w * (0.1 + 0.8 * Math.random());
      const y = h * 0.56 + (Math.random() - 0.5) * h * 0.3;
      v.sparks.spawn(x, y, 0, 0, 0.3, (3 + 4 * q.vel) * k, TWINKLE, INK);
    } else if (q.type === 'impact' && v.feel.motion !== 'warp') {
      for (let j = 0; j < 50; j++) {
        const a = Math.random() * TAU;
        const sp = (150 + Math.random() * 350) * k;
        v.sparks.spawn(
          w / 2,
          h * 0.56,
          Math.cos(a) * sp,
          Math.sin(a) * sp * 0.6,
          1.2,
          7 * k,
          GLOW,
          j % 2 ? ACCENT : ACCENT2,
          0,
          1.4,
        );
      }
    }
  },

  draw(v, ctx, w, h, t, dt) {
    const st = (v.state.drift ??= {
      n: 260,
      x: new Float32Array(260),
      y: new Float32Array(260),
      z: new Float32Array(260),
      ph: new Float32Array(260),
      mode: '',
    });
    const f = v.feel;
    const mode = f.motion;
    if (st.mode !== mode) drift.seed(st, mode);
    const P = v.pal;
    const k = v.k;
    const ry = h * 0.56;
    const go = v.playing ? 1 : 0.5;
    const push = 1 + 0.05 * v.kick * v.punch + 0.25 * v.impact ** 2 * (v.reduced ? 0.3 : 1);

    if (mode === 'warp') {
      const speed =
        (0.06 +
          0.5 * v.energy +
          0.6 * v.kick * v.punch * v.energy +
          0.9 * v.tension * (1 - v.hold) +
          2.2 * v.impact ** 2) *
        v.calm *
        go;
      const fov = Math.max(w, h) * 0.35;
      for (let i = 0; i < st.n; i++) {
        st.z[i] -= speed * dt * 0.5;
        if (st.z[i] < 0.03) {
          st.x[i] = Math.random() * 2 - 1;
          st.y[i] = Math.random() * 2 - 1;
          st.z[i] = 1;
        }
      }
      ctx.strokeStyle = P.inkCss;
      for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = (pass ? 0.75 : 0.32) * (v.dark ? 1 : 0.7);
        ctx.lineWidth = (pass ? 1.6 : 1) * k;
        ctx.beginPath();
        for (let i = 0; i < st.n; i++) {
          const z = st.z[i];
          if (z < 0.35 !== Boolean(pass)) continue;
          const z2 = Math.min(1.2, z + 0.03 + speed * 0.05);
          const x = w / 2 + (st.x[i] / z) * fov;
          const y = ry + (st.y[i] / z) * fov;
          if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
          ctx.moveTo(w / 2 + (st.x[i] / z2) * fov, ry + (st.y[i] / z2) * fov);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else if (mode === 'rain') {
      const fall = (0.04 + 0.1 * v.energy + 0.12 * v.tension) * v.calm * go * dt;
      for (let i = 0; i < st.n; i++) {
        st.y[i] += fall * (0.35 + 0.65 * st.z[i]);
        st.x[i] += 0.01 * Math.sin(t * 0.3 + st.ph[i]) * f.sway * dt;
        if (st.y[i] > 1.04) {
          st.y[i] -= 1.08;
          st.x[i] = Math.random();
        }
      }
      ctx.strokeStyle = P.inkCss;
      ctx.lineWidth = Math.max(1, k);
      const len = (0.7 + 0.6 * v.energy) * k;
      for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = pass ? 0.32 : 0.15;
        ctx.beginPath();
        for (let i = 0; i < st.n; i++) {
          if (st.z[i] < 0.6 !== !pass) continue;
          const x = st.x[i] * w;
          const y = ry + (st.y[i] * h - ry) * push;
          const l = (5 + 16 * st.z[i]) * len;
          ctx.moveTo(x, y);
          ctx.lineTo(x + l * 0.08, y - l);
        }
        ctx.stroke();
      }
    } else {
      const rise = (0.012 + 0.03 * v.energy) * v.calm * go * dt;
      const ryN = ry / h;
      if (v.dark) ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 170; i++) {
        st.y[i] -= rise * (0.35 + 0.65 * st.z[i]);
        st.x[i] += 0.012 * Math.sin(t * 0.5 + st.ph[i]) * f.sway * dt;
        // the build gathers them toward the ribbon
        st.y[i] += (ryN - st.y[i]) * v.tension * 0.6 * dt;
        if (st.y[i] < -0.05) {
          st.y[i] += 1.1;
          st.x[i] = Math.random();
        }
        const z = st.z[i];
        const s = (2 + 13 * z * z) * k * (1 + 0.15 * v.high);
        ctx.globalAlpha = (0.08 + 0.22 * z) * (0.6 + 0.4 * v.energy) * (v.dark ? 1 : 0.8);
        const y = ry + (st.y[i] * h - ry) * push;
        ctx.drawImage(v.bokeh[i % 2 ? ACCENT2 : ACCENT], st.x[i] * w - s, y - s, s * 2, s * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // the ribbon: strands of the waveform fanned out and twisting like silk;
    // the outer strands use copies from a moment ago so they trail behind
    const A = h * (0.08 + 0.12 * v.energy) * (1 + 0.35 * v.kick * v.punch);
    const x0 = w * 0.03;
    const x1 = w * 0.97;
    const M = 110;
    const strands = 9;
    const spread = h * (0.1 + 0.04 * v.energy + 0.05 * v.tension) * (mode === 'bokeh' ? 1.4 : 1);
    const twist = t * 0.6 * v.calm;
    const bright = Math.min(1, 0.6 + 0.4 * v.energy + 0.3 * v.snare);
    ctx.lineJoin = 'round';
    for (let j = 0; j < strands; j++) {
      const across = j / (strands - 1) - 0.5;
      const lag = Math.min(HISTORY - 1, Math.round(Math.abs(across) * 6));
      const wave = lag ? v.hist[(v.histIdx - lag + 1 + HISTORY * 2) % HISTORY] : v.wave;
      const gain = 1 - Math.abs(across) * 0.8;
      ctx.beginPath();
      for (let i = 0; i <= M; i++) {
        const u = i / M;
        const env = Math.sin(Math.PI * u);
        const fan = across * spread * Math.sin(u * 5.5 + twist + j * 0.3);
        const y = ry + env * (fan - wave[(u * (WAVE - 1)) | 0] * A * gain);
        if (i) ctx.lineTo(x0 + (x1 - x0) * u, y);
        else ctx.moveTo(x0, y);
      }
      const centre = j === (strands - 1) / 2;
      ctx.globalAlpha = (centre ? 0.95 : 0.7 - Math.abs(across) * 0.9) * bright;
      ctx.strokeStyle = centre || j % 2 ? P.accentCss : P.accent2Css;
      ctx.lineWidth = (centre ? 2.2 : 1.1) * k;
      ctx.stroke();
      if (centre) {
        ctx.lineTo(x1, ry);
        ctx.lineTo(x0, ry);
        ctx.globalAlpha = v.dark ? 0.07 : 0.09;
        ctx.fillStyle = P.accentCss;
        ctx.fill();
      }
    }

    // chops: lanterns on thin stems from the ribbon
    const N = v.notes;
    for (let i = 0; i < MAX_NOTES; i++) {
      const life = clamp(1 + N.dur[i] * 2.5, 1.2, 3);
      const pp = v.noteProgress(i, t, life);
      if (pp < 0) continue;
      drift.lantern(v, w, h, N.seed[i], N.pn[i], pp * life);
      const x = PT[0];
      const y = PT[1];
      const a = (1 - pp) ** 1.3;
      ctx.globalAlpha = a * 0.2;
      ctx.strokeStyle = P.inkCss;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, ry);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = a * 0.6;
      ctx.strokeStyle = P.accent2Css;
      ctx.lineWidth = Math.max(1, 1.2 * k);
      ctx.beginPath();
      ctx.arc(x, y, (5 + 24 * (1 - (1 - pp) ** 2)) * k, 0, TAU);
      ctx.stroke();
      const g = (14 + 22 * N.vel[i]) * k;
      if (v.dark) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.85;
      ctx.drawImage(v.glow[ACCENT2], x - g, y - g, g * 2, g * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = a;
      ctx.fillStyle = P.inkCss;
      const c = Math.max(2, 3 * k);
      ctx.fillRect(x - c / 2, y - c / 2, c, c);
    }
    ctx.globalAlpha = 1;
  },
};

const SCENE_IMPL = { spectrum, orbit, horizon, word, drift };
