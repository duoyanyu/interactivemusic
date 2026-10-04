// Mic capture with MediaRecorder, plus decoding of recordings and uploads
// into plain mono Float32Arrays.

import { toMono } from './audio-utils.js';

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function micSupported() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return false;
  // embedded pages (iframes without allow="microphone") can't ask at all
  const policy = document.permissionsPolicy ?? document.featurePolicy;
  return policy?.allowsFeature ? policy.allowsFeature('microphone') : true;
}

export class MicRecorder {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.stream = null;
    this.recorder = null;
    this.analyser = null;
    this.timer = null;
  }

  get recording() {
    return this.recorder?.state === 'recording';
  }

  /**
   * Starts recording and resolves with the finished Blob once stop() is
   * called or maxSeconds runs out. Rejects if the mic can't be opened.
   */
  async start({ maxSeconds = 2.5 } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.startedAt = performance.now();
    this.maxSeconds = maxSeconds;

    const chunks = [];
    const done = new Promise((resolve, reject) => {
      this.recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      this.recorder.onstop = () => {
        this._release(source);
        resolve(new Blob(chunks, { type: this.recorder.mimeType || mimeType || 'audio/webm' }));
      };
      this.recorder.onerror = (e) => {
        this._release(source);
        reject(e.error || new Error('Recording failed'));
      };
    });
    this.recorder.start();
    this.timer = setTimeout(() => this.stop(), maxSeconds * 1000);
    if (this.cancelled) this.stop();
    return done;
  }

  elapsed() {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  // the mic may still be opening; stop() then cancels once it's up
  stop() {
    this.cancelled = true;
    clearTimeout(this.timer);
    if (this.recording) this.recorder.stop();
  }

  // Live input waveform, for the meter while recording.
  readWaveform(target) {
    if (this.analyser) this.analyser.getFloatTimeDomainData(target);
    return target;
  }

  _release(source) {
    try {
      source.disconnect();
    } catch {
      // already gone
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
  }
}

export async function decodeToMono(arrayBuffer, audioContext) {
  const audio = await audioContext.decodeAudioData(arrayBuffer);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  return { samples: toMono(channels), sampleRate: audio.sampleRate };
}
