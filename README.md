# google-meet-bot

Minimal Google Meet recorder. Joins a meeting with a signed-in Google account, waits in the lobby until admitted, records mixed meeting audio to mp3 and exposes a live audio stream (format configurable via ffmpeg).

## Setup (Windows)

```
npm install
npm run login                 # sign in to the bot account in the opened Chrome, then press Enter
node example.js https://meet.google.com/xxx-xxxx-xxx
```

Type `stop` + Enter (or Ctrl+C) to leave. The bot also leaves when the meeting ends, when it is removed, or after 5 minutes alone.

## Usage

```js
const { MeetBot } = require('./meet-recorder');

const bot = new MeetBot({
  url: 'https://meet.google.com/xxx-xxxx-xxx',
  mp3Path: './recording.mp3',                                  // null = no mp3
  stream: { format: 's16le', sampleRate: 16000, channels: 1 }, // null = no stream
});
bot.audio.pipe(sttClient);  // live audio
bot.on('ended', (reason) => console.log(reason));
await bot.start();          // resolves once admitted and recording
await bot.stop();           // leave + finalize mp3
```

Events: `waiting`, `joined`, `participants` (count), `ended` (reason).

### Options

| option | default | |
|---|---|---|
| `profileDir` | `./chrome-profile` | Chrome profile with the signed-in account |
| `authFile` | `null` | cookies json from `login.js` (for other machines) |
| `headless` | `false` | |
| `channel` | `'chrome'` | `undefined` = Playwright's bundled Chromium |
| `mp3Bitrate` | `'128k'` | |
| `stream.format` | `'s16le'` | any ffmpeg muxer: `s16le`, `f32le`, `mulaw`, `alaw`, `wav`, `mp3`, `ogg`, `webm`... |
| `stream.sampleRate` / `channels` | `16000` / `1` | |
| `stream.codec` | `null` | e.g. `'libopus'` for `ogg`/`webm` |
| `stream.ffmpegArgs` | `[]` | extra ffmpeg output args |
| `admitTimeoutMs` | 10 min | max time in the waiting room |
| `aloneTimeoutMs` | 5 min | leave after being alone this long |

Stream examples: Deepgram/Whisper-style raw PCM → default; Twilio-style → `{ format: 'mulaw', sampleRate: 8000 }`; Opus → `{ format: 'webm', codec: 'libopus', sampleRate: 48000 }`.

## Linux deploy

```
npm install
npx playwright install --with-deps chrome
sudo apt install -y xvfb pulseaudio
pulseaudio --start --exit-idle-time=-1   # Chrome needs an audio output device
xvfb-run -a node example.js <meet url>
```

Chrome profiles aren't portable between OSes (cookies are encrypted per OS), so copy `auth.json` from `npm run login` next to the script — `example.js` picks it up automatically. Headful under `xvfb-run` is the reliable mode; `HEADLESS=1` may be rejected by Meet.

## How it works

Current Meet decodes remote audio itself and plays it through its own WebAudio `AudioContext`s (no `<audio>` elements; WebRTC's own decoder stays idle). The bot patches `AudioNode.prototype.connect` so every connection to the speakers goes through a tee that also feeds a capture stream (same technique as [Attendee](https://github.com/noah-duncan/attendee)'s Zoom bot). Playing `<audio>` elements are tapped as well, in case Meet switches back. Sources are mixed with an AudioWorklet and 48 kHz PCM is sent to Node; a `debug:` dump is logged 20 s after joining. Meet's UI sounds (join chimes) are captured too, since they play through the same output. One ffmpeg process writes the mp3 and the converted live stream. The meeting UI is driven by English labels (`hl=en` is forced), so Meet UI changes may need selector updates in `join()` / `monitor()`.
