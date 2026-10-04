# Chop Shop

Say one word into your mic and get a whole track built around it.

Chop Shop records a short word, trims the silence, figures out what note you said it on, and turns it into a pitched sampler. Then it writes a song in the mood you pick (sad, hype or dreamy) with an intro, build, drop and outro: synth pad chords, drums and bass in the same key, and your word chopped up as the lead melody on top. Reverb and a tempo-synced delay are on faders, and Randomize rolls a fresh song in the same mood.

Everything runs in the browser with [Tone.js](https://tonejs.github.io/). Your recording never leaves the page.

## Run it

It's a static site with no build step, but it has to be served over `http://localhost` or `https://` (ES modules and the microphone don't work from `file://`).

```sh
npm start          # serves on http://localhost:5173
# or
python3 -m http.server 5173
```

Open the page, hit **Rec**, say a word. A demo voice is loaded at startup so you can hit **Play** straight away.

### Controls

| | |
| --- | --- |
| **Rec** / <kbd>R</kbd> | record up to 2.5 s; click again to stop early |
| **Upload a clip** | use any audio file instead of the mic (first 12 s, trimmed the same way) |
| **Mood pads** | sad, hype or dreamy. Picking one writes a new song |
| **Play** / <kbd>Space</kbd> | play or stop the song |
| **Randomize** | new key, tempo, chords, groove, melody, sounds and effect settings in the same mood |
| **Export WAV** | renders the whole song offline and downloads it |
| Arrangement screen | click a section to jump there |
| Keyboard / <kbd>A</kbd>–<kbd>;</kbd> | play your word at any pitch |

## How it works

1. **Record** (`src/recorder.js`): `MediaRecorder` captures the mic, the result is decoded and mixed to mono.
2. **Trim** (`src/audio-utils.js`): RMS in 10 ms windows, a threshold based on the loudest window and the noise floor, then it grows outwards from the loudest point and stops once it hits ~220 ms of quiet. Short gaps inside a word survive, stray clicks far away don't. Short fades go on both ends and the result is normalized.
3. **Pitch** (`src/audio-utils.js`): YIN over the louder frames, median of the results. If there's no clear pitch (whispers, "shh"), the word is treated as C4.
4. **Compose** (`src/composer.js`): seeded and pure, so the same seed and mood always give the same song.
   - Each mood has its own scales, chord progressions (as scale degrees), tempo range, grooves, synth patches and effect ranges.
   - Chords are voiced with voice leading so they don't jump around.
   - The hook is a 4-bar call and answer: bar 3 repeats bar 1 moved to fit its chord, bar 4 lands on a stable note. Strong beats prefer chord tones, weak beats move by step.
   - The intro teases the hook over filtered chords. The build stacks kick, snare roll, noise riser, rising chops and a filter sweep, then leaves a beat of silence. The drop brings in the full groove with sidechain pumping, a reversed-vocal swell into it, crash and sub drop, and stutters, octave jumps and harmonies on repeats. The outro thins out, echoes the hook and lands on the home chord.
   - The melody is placed around the pitch of your word, so chops stay close to its natural range.
5. **Play** (`src/engine.js`): Tone.js instruments scheduled on the transport. The vocal sampler is a small custom one (fractional root note, slice offsets, reversed copy). The engine only uses its own context, so the same code renders the WAV export through an `OfflineAudioContext`.

`src/main.js` wires up the UI and `src/viz.js` draws the little screens.

## Tests

The music and DSP code is plain JavaScript with no audio dependencies, so it's tested with Node's built-in runner:

```sh
npm test
```

It covers silence trimming, pitch detection, chord naming and voicing, song structure, keeping everything in key, chop range, and the WAV encoder.

## Notes

- Tone.js 15.1.22 loads from jsDelivr, and fonts load from Google Fonts. Offline, the page still opens but stays silent.
- On iPhone, the ring/silent switch mutes Web Audio. Flip it off if you hear nothing.
- Sung or held vowels ("ooh", "yeah", "hey") pitch-track better than clipped consonants.
- To add a mood, add an entry to `MOODS` in `src/composer.js` (and a pad in `index.html`). Synth patches live at the top of `src/engine.js`.
