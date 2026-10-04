// Canvas drawing for the little LCD screens.

export function fitCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function rgbOf(color) {
  const probe = document.createElement('span');
  probe.style.color = color;
  probe.style.display = 'none';
  document.body.append(probe);
  const parts = getComputedStyle(probe).color.match(/[\d.]+/g) ?? ['0', '0', '0'];
  probe.remove();
  return parts.slice(0, 3).map(Number);
}

// Reads the screen colours from CSS so both themes and every mood work.
export function lcdColors(el) {
  const css = getComputedStyle(el);
  const get = (name) => css.getPropertyValue(name).trim();
  const [r, g, b] = rgbOf(get('--lcd-ink'));
  return {
    bg: get('--lcd'),
    ink: `rgb(${r}, ${g}, ${b})`,
    dim: `rgba(${r}, ${g}, ${b}, 0.38)`,
    faint: `rgba(${r}, ${g}, ${b}, 0.13)`,
    accent: get('--accent'),
    font: get('--font-lcd') || 'monospace',
  };
}

function minMaxColumns(samples, columns) {
  const out = [];
  const per = samples.length / columns;
  for (let x = 0; x < columns; x++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(samples.length, Math.floor((x + 1) * per));
    for (let i = Math.floor(x * per); i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out.push([lo, hi]);
  }
  return out;
}

// The recorded take, with the kept part lit up and the trimmed silence dim.
export function drawSample(canvas, colors, { raw, start, end }) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  ctx.fillStyle = colors.faint;
  ctx.fillRect(0, mid, width, 1);
  if (!raw || !raw.length) return;

  const columns = Math.floor(width);
  const cols = minMaxColumns(raw, columns);
  let max = 0.0001;
  for (const [lo, hi] of cols) max = Math.max(max, -lo, hi);
  const scale = (height / 2 - 4) / max;
  const x0 = (start / raw.length) * width;
  const x1 = (end / raw.length) * width;

  cols.forEach(([lo, hi], x) => {
    const inside = x >= x0 && x <= x1;
    ctx.fillStyle = inside ? colors.ink : colors.dim;
    const top = mid - hi * scale;
    ctx.fillRect(x, top, 1, Math.max(1, (hi - lo) * scale));
  });

  ctx.fillStyle = colors.accent;
  for (const x of [x0, x1]) ctx.fillRect(Math.round(x), 0, 1, height);
  ctx.font = `13px ${colors.font}`;
  ctx.textBaseline = 'top';
  ctx.fillText('IN', Math.min(width - 16, x0 + 3), 3);
  ctx.textAlign = 'right';
  ctx.fillText('OUT', Math.max(20, x1 - 3), 3);
  ctx.textAlign = 'left';
}

// Live mic input while recording, with a time bar along the bottom.
export function drawLiveInput(canvas, colors, data, progress) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * width;
    const y = mid - data[i] * (height / 2 - 6) * 2.5;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = colors.faint;
  ctx.fillRect(0, height - 3, width, 3);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(0, height - 3, width * progress, 3);
}

export function drawScope(canvas, colors, data) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  const n = data ? data.length : 2;
  for (let i = 0; i < n; i++) {
    const v = data ? data[i] : 0;
    const x = (i / (n - 1)) * width;
    const y = height / 2 - Math.max(-1, Math.min(1, v)) * (height / 2 - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

const LANES = [
  { id: 'vox', label: 'VOX', weight: 1.5 },
  { id: 'keys', label: 'KEYS', weight: 1 },
  { id: 'bass', label: 'BASS', weight: 0.8 },
  { id: 'drums', label: 'DRUM', weight: 1 },
];

/**
 * The song overview: section strip on top, then a lane per part. The static
 * picture is cached; each frame only adds the playhead.
 */
export class ArrangementView {
  constructor(canvas) {
    this.canvas = canvas;
    this.cache = document.createElement('canvas');
    this.song = null;
    this.colors = null;
    this.gutter = 40;
    this.stripH = 22;
  }

  setSong(song, colors) {
    this.song = song;
    this.colors = colors;
    this.renderStatic();
  }

  stepToX(step) {
    const w = this.width - this.gutter - 4;
    return this.gutter + (step / this.song.totalSteps) * w;
  }

  xToStep(x) {
    const w = this.width - this.gutter - 4;
    return ((x - this.gutter) / w) * this.song.totalSteps;
  }

  renderStatic() {
    const { width, height } = fitCanvas(this.canvas);
    this.width = width;
    this.height = height;
    const dpr = this.canvas.width / width;
    this.cache.width = this.canvas.width;
    this.cache.height = this.canvas.height;
    const ctx = this.cache.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!this.song) return;
    const { song, colors } = this;
    const T = song.tracks;

    // lanes, with the gutter sized to the widest label
    ctx.font = `14px ${colors.font}`;
    this.gutter = Math.ceil(Math.max(...LANES.map((l) => ctx.measureText(l.label).width))) + 12;
    const top = this.stripH + 6;
    const totalWeight = LANES.reduce((s, l) => s + l.weight, 0);
    const laneGap = 5;
    let y = top;
    const lanes = {};
    for (const lane of LANES) {
      const h = ((height - top - laneGap * (LANES.length - 1) - 2) * lane.weight) / totalWeight;
      lanes[lane.id] = { y, h };
      ctx.fillStyle = colors.faint;
      ctx.fillRect(this.gutter, y + h, width - this.gutter - 4, 1);
      ctx.fillStyle = colors.dim;
      ctx.font = `14px ${colors.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(lane.label, 4, y + h / 2);
      y += h + laneGap;
    }
    this.lanes = lanes;

    // bar lines
    ctx.fillStyle = colors.faint;
    for (let bar = 0; bar <= song.totalBars; bar += 4) {
      ctx.fillRect(Math.round(this.stepToX(bar * 16)), top, 1, height - top);
    }

    const pitchLane = (events, lane, key, color, minH = 2) => {
      if (!events.length) return;
      const notes = events.map((e) => e[key]);
      const lo = Math.min(...notes) - 1;
      const hi = Math.max(...notes) + 1;
      ctx.fillStyle = color;
      for (const e of events) {
        const x = this.stepToX(e.step);
        const w = Math.max(1.5, this.stepToX(e.step + e.dur) - x - 0.5);
        const yy = lane.y + lane.h - ((e[key] - lo) / (hi - lo)) * lane.h;
        ctx.globalAlpha = 0.45 + 0.55 * (e.vel ?? 1);
        ctx.fillRect(x, yy - minH / 2, w, minH);
      }
      ctx.globalAlpha = 1;
    };

    pitchLane(T.vox, lanes.vox, 'midi', colors.accent, 3);
    // pads as soft blocks, keys on top
    ctx.fillStyle = colors.dim;
    for (const e of T.pad) {
      const x = this.stepToX(e.step);
      const w = this.stepToX(Math.min(song.totalSteps, e.step + e.dur)) - x - 1;
      ctx.globalAlpha = 0.25 + 0.4 * e.vel;
      ctx.fillRect(x, lanes.keys.y + lanes.keys.h * 0.35, Math.max(1, w), lanes.keys.h * 0.65);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ink;
    for (const e of T.keys) {
      const x = this.stepToX(e.step);
      ctx.fillRect(x, lanes.keys.y + 1, Math.max(1, this.stepToX(e.step + e.dur) - x - 0.5), 3);
    }
    pitchLane(T.bass, lanes.bass, 'note', colors.ink, 2.5);

    const d = lanes.drums;
    const tick = (events, y0, h, alpha = 1) => {
      for (const e of events) {
        ctx.globalAlpha = alpha * (0.35 + 0.65 * e.vel);
        ctx.fillRect(this.stepToX(e.step), y0, 1.2, h);
      }
      ctx.globalAlpha = 1;
    };
    ctx.fillStyle = colors.ink;
    tick(T.kick, d.y + d.h * 0.62, d.h * 0.38);
    tick([...T.snare, ...T.roll], d.y + d.h * 0.32, d.h * 0.26);
    ctx.fillStyle = colors.dim;
    tick([...T.hat, ...T.ohat], d.y + 1, d.h * 0.22, 0.9);
    ctx.fillStyle = colors.accent;
    tick(T.crash, d.y, d.h);
  }

  // Draws the cached picture plus section highlight and playhead.
  frame(position, currentSectionId) {
    if (!this.song) return;
    const ctx = this.canvas.getContext('2d');
    const dpr = this.canvas.width / this.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { colors, song } = this;

    // section strip
    ctx.font = `15px ${colors.font}`;
    ctx.textBaseline = 'middle';
    for (const s of song.sections) {
      const x0 = this.stepToX(s.startStep);
      const x1 = this.stepToX(s.endStep);
      const active = s.id === currentSectionId;
      ctx.fillStyle = active ? colors.accent : colors.faint;
      ctx.fillRect(x0 + 1, 2, x1 - x0 - 2, this.stripH - 4);
      ctx.fillStyle = active ? colors.bg : colors.ink;
      const label = `${s.name.toUpperCase()} ${s.bars}`;
      if (ctx.measureText(label).width < x1 - x0 - 8) ctx.fillText(label, x0 + 5, this.stripH / 2 + 1);
      else if (ctx.measureText(s.name[0]).width < x1 - x0 - 6) ctx.fillText(s.name[0], x0 + 4, this.stripH / 2 + 1);
    }

    if (position > 0) {
      const x = this.stepToX(Math.min(position, song.totalSteps));
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(this.gutter, this.stripH + 4, x - this.gutter, this.height - this.stripH - 4);
      ctx.globalAlpha = 1;
      ctx.fillRect(Math.round(x), 0, 2, this.height);
    }
  }

  sectionAtX(x) {
    if (!this.song || x < this.gutter) return null;
    const step = this.xToStep(x);
    return this.song.sections.find((s) => step >= s.startStep && step < s.endStep) ?? null;
  }
}
