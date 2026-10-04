# Chop Shop

Say one word into your mic and get a whole track, and a light show, built around it.

Chop Shop records a short word, trims the silence, figures out what note you said it on, and chops it into slices. Your word becomes a pitched sampler and a set of jam pads. Then it writes a song in the mood you pick, with an intro, build, drop and outro: chords, drums and bass in the same key, and your word cut up as the lead melody on top. Every choice is editable, the visuals react to every hit, and there's a fullscreen stage mode plus an exhibit mode for walk-up installations.

Everything runs in the browser with [Tone.js](https://tonejs.github.io/). Your recording never leaves the page.

## Run it

It's a static site with no build step, but it has to be served over `http://localhost` or `https://` (ES modules and the microphone don't work from `file://`).

```sh
npm start          # serves on http://localhost:5173
# or
python3 -m http.server 5173
```

Or host it anywhere static, like GitHub Pages: Settings → Pages → deploy from a branch → `/ (root)`.

Open the page, hit **Rec**, say a word. A demo voice and a song are loaded at startup, so **Play** works straight away.

## What's in it

**Your word.** Records up to 3 s, or upload any clip. It's trimmed, pitch-tracked and chopped into slices, either automatically at syllables and consonants or into 2, 4 or 8 even pieces. The slices show up on the screen and as jam pads you can play live (keys 1 to 8). They land on the next 16th note, so they stay in time.

**8 moods.** Sad, Hype, Dreamy, Happy, Dark, Chill, Retro and Epic. Each has its own scales, chord progressions, tempo range, grooves, drum kit, synth sounds, background texture and effect settings.

**Studio.** Change anything while the song plays; it picks up from the same bar.

| Group | Controls |
| --- | --- |
| Harmony | key, scale (major, minor, dorian, phrygian, lydian, mixolydian), chord progression, triads / 7ths / 9ths |
| Groove | tempo, beat, drum kit, swing, sidechain pump |
| Sounds | pad, keys sound, keys pattern (held, arps, stabs, pulse), bass, background texture |
| Chops | whole word or slices (in order or shuffled), pitch, how many notes, note length, start from the word or its vowel, stutters, harmonies, octave jumps |
| Structure | bars in the intro, build, drop and outro |

Lock a group and **Randomize** or a new mood leaves it alone. **New melody** re-rolls only the chop melody. The **song code** is the whole recipe in one string: copy it, paste it back later, and you get the same song.

**Sound slots.** Swap the kick, snare, hat or perc for your own noises: beatbox into the mic, upload a clip, or drop in a slice of your word. Each slot can be retuned.

**Live chords.** Switch the keys to *Live chords* and press any note. You hear the chord that fits the song's key (D in C major gives Dm), and the bass, keys and vocal chops follow whatever you play. *Loop the drop* keeps the drop going so you can jam over it. Plug in a MIDI keyboard (Chrome or Edge) and hold a chord; it reads which chord you played.

**Visuals.** A reactive stage with several scenes. It punches on kicks, sparkles on hats, puts every chop on screen at its pitch, shifts colour with the chords and goes big on the drop. You can type your word to show it as moving type. **Stage mode** (Shift+F) goes fullscreen with the jam pads and an XY effects pad: left closes a filter, right thins it out, up throws the whole mix into the echo.

**8D chops.** Turn it on and the vocal chops circle around your head (wear headphones).

**Mix & effects.** Level and mute for vox, chords, keys, bass, drums and FX, plus reverb, room size, tempo-synced ping-pong delay, echoes and master.

**Export WAV.** Renders the whole song offline, with your sounds, mix and effects, and downloads it.

## Exhibit mode

Built for installations: a big screen, speakers, a mic, and visitors walking up.

Open it with the **Exhibit mode** button, or go straight there with `#exhibit` on the end of the URL (handy for a kiosk browser). It shows an attract screen with the visuals idling and one big button. A visitor taps it and says a word, picks one of eight vibe tiles, and their song plays fullscreen with the visuals and jam pads. When it ends (or they tap *Start over*) it resets for the next person and throws their recording away. If someone walks off on the vibe screen, it resets after a minute. Esc or the faint *Exit* in the corner gets staff out.

Practical notes for a venue:
- Use Chrome or Edge in kiosk mode (`--kiosk --autoplay-policy=no-user-gesture-required`) and allow the microphone for the page once.
- A directional or handheld mic beats a laptop mic in a noisy room. The trimmer keeps only the loudest part, so background chatter mostly gets cut.
- MIDI keyboards and controllers work too, for a "play the chords" station next to the screen.

## On phones

- A control bar sits at the bottom of the screen: record, play/stop, new song and stage, plus where you are in the song.
- The keyboard shows one octave that fits the screen; − and + move it up and down.
- Sound plays on iPhone even with the silent switch on, and comes back after a call or switching apps.
- The screen stays awake while a song plays.
- Phones get slightly lighter synths so playback doesn't stutter.
- **Add to Home Screen** installs it as an app that opens full screen. After the first visit it also works offline (the app files and a copy of Tone.js are cached).

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| Space | play / stop |
| Shift+R | record |
| 1–8 | slice pads |
| A … ; | play your word, or chords in live mode (every plain letter is a note) |
| Shift+C | switch between word and live chords |
| Shift+F | stage mode |
| Esc | leave stage / exhibit mode |

## How it works

1. **Record** (`src/recorder.js`): `MediaRecorder` captures the mic. The result is decoded and mixed to mono.
2. **Trim** (`src/audio-utils.js`): finds the word around the loudest moment and cuts the silence.
3. **Pitch** (`src/audio-utils.js`): YIN over the louder frames, median of the results. If there's no clear pitch, the word is treated as C4.
4. **Slice** (`src/slicer.js`): an onset detector finds syllable and consonant starts, and the boundaries snap to zero crossings.
5. **Recipe** (`src/composer.js` `rollRecipe`): one object with every musical choice: key, scale, chords, tempo, groove, kit, sounds, chop style, structure, effects and the melody seed. Moods (`src/moods.js`) decide what gets picked. The studio edits this object directly.
6. **Compose** (`src/composer.js` `buildSong`): pure and deterministic.
   - Chords are voiced so they move smoothly.
   - The hook is a call-and-answer phrase. Bar 3 repeats bar 1, moved to fit its chord.
   - The build stacks drums, a snare roll, a riser and rising chops, then leaves a beat of silence before the drop. The drop gets sidechain pumping, a reversed-vocal swell and stutters/harmonies on repeats.
   - The melody sits around the pitch of your word.
7. **Play** (`src/engine.js`): Tone.js instruments built from `src/patches.js`, scheduled on the transport. The vocal sampler is custom, with a fractional root note, slices and a reversed copy. Mixer channels, sound slots, live chords, the 8D panner and the XY pad all live here. The engine only uses its own context, so the same code renders the WAV export through an `OfflineAudioContext`.
8. **Show** (`src/visualizer.js`): Canvas 2D scenes driven by the FFT and by events from the engine (kick, snare, hat, chop, chord, section, drop).

`src/main.js` wires up the UI, and `src/viz.js` draws the small LCD screens.

## Tests

The music and DSP code is plain JavaScript with no audio dependencies, so Node's built-in runner covers it:

```sh
npm test
```

The tests cover trimming, pitch detection, slicing, chord naming, voicing and recognition, every mood's data, song structure, keeping everything in key, chop range, recipes and song codes, and the WAV encoder.

## Notes

- Tone.js 15.1.22 loads from jsDelivr, and fonts load from Google Fonts. Offline, the page opens but stays silent.
- On iPhone, the ring/silent switch mutes Web Audio. Flip it off if you hear nothing.
- Sung or held vowels pitch-track best. Words with clear syllables ("ba-na-na", "let's go") chop best.
- To add a mood, add an entry to `MOODS` in `src/moods.js`; the pads and studio menus pick it up automatically. Sounds and kits live in `src/patches.js`.
