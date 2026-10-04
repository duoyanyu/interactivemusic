import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/wav.js';

test('encodeWav writes a 16-bit PCM stereo file', async () => {
  const left = new Float32Array([0, 0.5, -0.5, 1.5]);
  const right = new Float32Array([1, -1, 0.25, -2]);
  const fake = { numberOfChannels: 2, sampleRate: 44100, length: 4, getChannelData: (c) => (c ? right : left) };
  const blob = encodeWav(fake);
  assert.equal(blob.type, 'audio/wav');
  const view = new DataView(await blob.arrayBuffer());
  const text = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(o + i)));
  assert.equal(text(0), 'RIFF');
  assert.equal(text(8), 'WAVE');
  assert.equal(text(36), 'data');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 4 * 2 * 2);
  assert.equal(blob.size, 44 + 16);
  // interleaved L R L R ..., clipped to the 16-bit range
  const samples = Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true));
  assert.deepEqual(samples, [0, 32767, 16383, -32768, -16384, 8191, 32767, -32768]);
});
