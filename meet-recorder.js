// Minimal Google Meet recorder: joins a meeting with a signed-in Chrome profile,
// captures the mixed meeting audio, writes an mp3 and exposes a live audio stream.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const CAPTURE_RATE = 48000; // page always sends 48 kHz mono s16le to Node

const DEFAULTS = {
  url: null,
  profileDir: './chrome-profile',
  authFile: null, // optional storageState json from login.js (portable to Linux)
  headless: false,
  channel: 'chrome', // installed Google Chrome; set undefined for Playwright's Chromium
  botName: 'Recorder Bot', // only used if Meet asks for a guest name
  mp3Path: './recording.mp3', // null disables the mp3
  mp3Bitrate: '128k',
  // Live stream output (null disables). `format` is any ffmpeg muxer:
  // s16le, s16be, f32le, mulaw, alaw, wav, mp3, ogg, webm, ...
  stream: { format: 's16le', sampleRate: 16000, channels: 1, codec: null, ffmpegArgs: [] },
  admitTimeoutMs: 10 * 60_000, // how long to sit in the waiting room
  aloneTimeoutMs: 5 * 60_000, // leave after being alone this long
  log: (...a) => console.log('[meet-bot]', ...a),
};

// Chrome's fake mic plays a beep; feed it silence instead so nothing leaks into the call.
function silentWav() {
  const file = path.join(os.tmpdir(), 'meet-bot-silence.wav');
  if (fs.existsSync(file)) return file;
  const data = Buffer.alloc(CAPTURE_RATE * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(CAPTURE_RATE, 24); h.writeUInt32LE(CAPTURE_RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

function launchBrowser({ profileDir = DEFAULTS.profileDir, headless = false, channel = DEFAULTS.channel } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    channel,
    viewport: null,
    handleSIGINT: false, // let the caller leave the meeting gracefully on Ctrl+C
    ignoreDefaultArgs: ['--enable-automation', '--mute-audio'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silentWav()}`,
      '--lang=en-US',
      '--start-maximized',
    ],
  });
}

// Runs inside the Meet page and pushes 48 kHz mono s16le chunks (base64) to Node.
// Meet decodes remote audio itself and plays it through its own AudioContexts (no <audio>
// elements, WebRTC's decoder stays idle), so - like Attendee's Zoom bot - every connection to
// a speaker destination is rerouted through a tee that also feeds a capture stream.
// Playing <audio>/<video> elements are tapped too, in case Meet goes back to them.
function pageCapture() {
  const BLOCK = 4096;
  const taps = []; // streams of everything Meet's AudioContexts play to the speakers
  const sources = new Map(); // stream id -> source node in our mixing context
  const pcs = new Set(); // only used for the network-level diagnostic
  const pageContexts = []; // only used for diagnostics
  let ctx, mix;
  let peak = 0;
  let netPeak = 0;

  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends OrigPC {
    constructor(...args) {
      super(...args);
      pcs.add(this);
    }
  };

  const OrigAC = window.AudioContext;
  window.AudioContext = class extends OrigAC {
    constructor(...args) {
      super(...args);
      pageContexts.push(this);
    }
  };

  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (!(target instanceof AudioDestinationNode) || this.context === ctx) return origConnect.call(this, target, ...rest);
    const c = this.context;
    if (!c.__meetRecorderTee) {
      const tee = c.createGain();
      const tap = c.createMediaStreamDestination();
      origConnect.call(tee, c.destination); // keep normal playback
      origConnect.call(tee, tap); // capture
      c.__meetRecorderTee = tee;
      taps.push(tap.stream);
      if (mix) attach(tap.stream, 'page AudioContext');
    }
    return origConnect.call(this, c.__meetRecorderTee, ...rest);
  };
  // keep Meet's own disconnect(destination) calls valid now that nodes are wired to the tee
  AudioNode.prototype.disconnect = function (...args) {
    if (args[0] instanceof AudioDestinationNode && this.context.__meetRecorderTee) args[0] = this.context.__meetRecorderTee;
    return origDisconnect.apply(this, args);
  };

  function attach(stream, from) {
    if (sources.has(stream.id)) return;
    const src = ctx.createMediaStreamSource(stream);
    origConnect.call(src, mix);
    sources.set(stream.id, src);
    window.__meetRecorderLog(`audio source connected (${from}, ${sources.size} total)`);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      src.disconnect();
      sources.delete(stream.id);
    });
  }

  function scanElements() {
    document.querySelectorAll('audio, video').forEach((el) => {
      const stream = el.srcObject;
      if (el.paused || !(stream instanceof MediaStream) || !stream.getAudioTracks().length) return;
      attach(stream, `<${el.tagName.toLowerCase()}>`);
    });
  }

  // AudioWorklet runs on the audio thread; ScriptProcessor drops/duplicates buffers when Meet's main thread is busy.
  // With no input connected it emits silence, so the recording timeline stays continuous.
  const WORKLET = `registerProcessor('meet-recorder', class extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(${BLOCK}); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      for (let i = 0; i < 128; i++) {
        this.buf[this.n++] = ch ? ch[i] : 0;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(this.buf.length); this.n = 0; }
      }
      return true;
    }
  });`;

  function emit(f) {
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    const u8 = new Uint8Array(i16.buffer);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    window.__meetRecorderPush(btoa(bin));
  }

  // Loudest inbound RTP audio as WebRTC reports it (stays 0 when Meet decodes audio itself)
  async function sampleNetwork() {
    for (const pc of pcs) {
      if (pc.connectionState === 'closed') { pcs.delete(pc); continue; }
      const stats = await pc.getStats().catch(() => null);
      stats?.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.audioLevel > netPeak) netPeak = s.audioLevel;
      });
    }
  }

  const dB = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');

  window.__meetRecorderDebug = async () => {
    const inbound = [];
    for (const pc of pcs) {
      const stats = await pc.getStats().catch(() => null);
      stats?.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          inbound.push({ packets: s.packetsReceived, bytes: s.bytesReceived, audioLevel: s.audioLevel, samples: s.totalSamplesReceived });
        }
      });
    }
    return {
      peerConnections: [...pcs].map((pc) => pc.connectionState),
      inboundAudio: inbound,
      mediaElements: document.querySelectorAll('audio, video').length,
      pageAudioContexts: pageContexts.filter((c) => c !== ctx).map((c) => `${c.state}@${c.sampleRate}${c.__meetRecorderTee ? ' (tapped)' : ''}`),
      captureSources: sources.size,
    };
  };

  // Active speaker + present names from participant tiles (selectors as used by Vexa; Meet's
  // speaking classes are obfuscated and may change). The bot's own tile is excluded.
  const SPEAKING_CLASSES = ['Oaajhc', 'HX2H7', 'wEsLMd', 'OgVli'];
  const JUNK_NAME = /^Google Participant \(|spaces\/|devices\//;
  function readTiles() {
    const tiles = new Map(); // participant id -> { name, speaking, self }
    document.querySelectorAll('[data-participant-id]').forEach((el) => {
      const id = el.getAttribute('data-participant-id');
      const name = (el.querySelector('span.notranslate')?.textContent || '').trim();
      const t = tiles.get(id) || { name: '', speaking: false, self: false };
      if (!t.name && name.length >= 2 && name.length <= 50 && !JUNK_NAME.test(name)) t.name = name;
      t.self ||= el.hasAttribute('data-self-name') || !!el.querySelector('[data-self-name]');
      t.speaking ||= SPEAKING_CLASSES.some((c) => el.classList.contains(c) || el.querySelector('.' + c));
      tiles.set(id, t);
    });
    const others = [...tiles.values()].filter((t) => t.name && !t.self);
    return {
      speaking: others.filter((t) => t.speaking).map((t) => t.name).sort(),
      present: [...new Set(others.map((t) => t.name))].sort(),
    };
  }
  let lastTiles = '';
  function pollSpeakers() {
    const tiles = readTiles();
    const key = JSON.stringify(tiles);
    if (key === lastTiles) return;
    lastTiles = key;
    window.__meetRecorderSpeakers(tiles.speaking, tiles.present);
  }

  window.__meetRecorderStart = async () => {
    if (ctx) return;
    ctx = new OrigAC({ sampleRate: 48000 });
    mix = ctx.createGain();
    const sink = ctx.createGain();
    sink.gain.value = 0; // capture node must reach destination to be pulled, but stay silent
    origConnect.call(sink, ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'meet-recorder', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => emit(e.data);
      mix.connect(node);
      node.connect(sink);
      window.__meetRecorderLog('capture: AudioWorklet');
    } catch (err) {
      const proc = ctx.createScriptProcessor(BLOCK, 1, 1); // 1 input channel => downmix to mono
      proc.onaudioprocess = (e) => emit(e.inputBuffer.getChannelData(0));
      mix.connect(proc);
      proc.connect(sink);
      window.__meetRecorderLog(`capture: ScriptProcessor (AudioWorklet failed: ${err.message})`);
    }
    await ctx.resume();
    taps.forEach((s) => attach(s, 'page AudioContext'));
    scanElements();
    setInterval(pollSpeakers, 250);
    setInterval(() => {
      scanElements();
      sampleNetwork();
    }, 1000);
    setInterval(() => {
      window.__meetRecorderLog(`audio: context=${ctx.state}, sources=${sources.size}, captured peak=${dB(peak)} dB, network peak=${dB(netPeak)} dB`);
      peak = 0;
      netPeak = 0;
    }, 10_000);
  };
}

async function visible(locator) {
  return locator.first().isVisible().catch(() => false);
}

async function clickIfVisible(locator) {
  if (await visible(locator)) await locator.first().click().catch(() => {});
}

class MeetBot extends EventEmitter {
  constructor(options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    if (options.stream !== null) this.opts.stream = { ...DEFAULTS.stream, ...options.stream };
    if (!this.opts.url) throw new Error('url is required');
    this.audio = this.opts.stream ? new PassThrough() : null;
    this.participants = 0;
    this.samples = 0;
    this.stopping = null;
  }

  // Seconds of captured audio so far: the shared clock for speakers and transcripts
  audioTime() {
    return this.samples / CAPTURE_RATE;
  }

  async start() {
    const o = this.opts;
    try {
      this.context = await launchBrowser(o);
      this.context.on('close', () => this.stop('browser closed'));
      if (o.authFile) {
        const { cookies } = JSON.parse(fs.readFileSync(o.authFile, 'utf8'));
        await this.context.addCookies(cookies);
      }
      const page = (this.page = this.context.pages()[0] || (await this.context.newPage()));
      await page.exposeFunction('__meetRecorderPush', (b64) => {
        if (this.stopping) return;
        const pcm = Buffer.from(b64, 'base64');
        this.samples += pcm.length / 2;
        this.ffmpeg?.stdin.write(pcm);
        this.emit('pcm', pcm); // raw 48 kHz mono s16le, e.g. for transcription
      });
      await page.exposeFunction('__meetRecorderSpeakers', (speaking, present) => {
        this.emit('speakers', { speaking, present, at: this.audioTime() });
      });
      await page.exposeFunction('__meetRecorderLog', (msg) => o.log(msg));
      await page.addInitScript(pageCapture);

      const url = new URL(o.url);
      url.searchParams.set('hl', 'en'); // selectors below rely on English UI
      o.log('opening', url.href);
      await page.goto(url.href);
      await this.join();

      this.startEncoder();
      await page.evaluate(() => window.__meetRecorderStart());
      o.log('joined, recording');
      this.emit('joined');
      this.monitor();
      // one-shot page dump for diagnosing capture problems
      this.debugTimer = setTimeout(async () => {
        const info = await page.evaluate(() => window.__meetRecorderDebug()).catch((e) => ({ error: e.message }));
        o.log('debug:', JSON.stringify(info, null, 1));
      }, 20_000);
    } catch (err) {
      await this.stop(`join failed: ${err.message}`);
      throw err;
    }
  }

  async join() {
    const { page, opts: o } = this;
    const joinBtn = page.getByRole('button', { name: /^(join now|ask to join)$/i });
    const leaveBtn = page.getByRole('button', { name: /leave call/i });
    const rejected = page.getByText(/denied your request|removed you from|can't join this call|meeting has ended/i);

    await joinBtn.first().waitFor({ timeout: 60_000 });
    await clickIfVisible(page.getByRole('button', { name: /^(got it|dismiss)$/i }));
    const nameInput = page.getByRole('textbox', { name: /your name/i });
    if (await visible(nameInput)) await nameInput.first().fill(o.botName);
    await clickIfVisible(page.getByRole('button', { name: /turn off microphone/i }));
    await clickIfVisible(page.getByRole('button', { name: /turn off camera/i }));

    const deadline = Date.now() + o.admitTimeoutMs;
    let clicks = 0;
    while (Date.now() < deadline) {
      if (await visible(leaveBtn)) break;
      if (await visible(rejected)) throw new Error(`not admitted: ${await rejected.first().innerText()}`);
      // first click, or re-ask after Meet's "no one responded" timeout
      if (await visible(joinBtn)) {
        const label = await joinBtn.first().innerText();
        await joinBtn.first().click().catch(() => {});
        o.log(clicks++ ? `asking again (${label})` : `clicked "${label}"`);
        if (/ask/i.test(label)) this.emit('waiting');
      }
      await page.waitForTimeout(2000);
    }
    if (!(await visible(leaveBtn))) throw new Error('timed out waiting to be admitted');
    await clickIfVisible(page.getByRole('button', { name: /turn off microphone/i }));
  }

  startEncoder() {
    const { mp3Path, mp3Bitrate, stream, log } = this.opts;
    if (!mp3Path && !stream) return;
    const args = ['-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(CAPTURE_RATE), '-ac', '1', '-i', 'pipe:0'];
    if (mp3Path) args.push('-c:a', 'libmp3lame', '-b:a', mp3Bitrate, '-y', mp3Path);
    if (stream) {
      args.push('-ar', String(stream.sampleRate), '-ac', String(stream.channels));
      if (stream.codec) args.push('-c:a', stream.codec);
      args.push(...(stream.ffmpegArgs || []), '-flush_packets', '1', '-f', stream.format, 'pipe:1');
    }
    this.ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', stream ? 'pipe' : 'ignore', 'pipe'] });
    if (stream) this.ffmpeg.stdout.pipe(this.audio);
    this.ffmpeg.stderr.on('data', (d) => log('[ffmpeg]', d.toString().trim()));
    this.ffmpeg.stdin.on('error', () => {});
  }

  monitor() {
    const { page, opts: o } = this;
    const leaveBtn = page.getByRole('button', { name: /leave call/i });
    let aloneSince = null;
    let misses = 0;

    const tick = async () => {
      if (this.stopping) return;
      try {
        // Leave button gone for a few ticks => meeting ended or we were removed
        misses = (await visible(leaveBtn)) ? 0 : misses + 1;
        if (misses >= 3) return this.stop('meeting ended or bot removed');

        const n = await page.evaluate(() =>
          new Set([...document.querySelectorAll('[data-participant-id]')].map((e) => e.getAttribute('data-participant-id'))).size);
        if (n !== this.participants) {
          this.participants = n;
          o.log('participants:', n);
          this.emit('participants', n);
        }
        // n === 0 means the selector found nothing (UI changed) - don't treat it as alone
        if (n === 1) {
          aloneSince ??= Date.now();
          if (Date.now() - aloneSince >= o.aloneTimeoutMs) return this.stop('alone in meeting');
        } else {
          aloneSince = null;
        }
      } catch (err) {
        if (page.isClosed()) return this.stop('browser closed');
      }
      this.timer = setTimeout(tick, 2000);
    };
    tick();
  }

  stop(reason = 'stop requested') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      clearTimeout(this.timer);
      clearTimeout(this.debugTimer);
      this.opts.log('leaving:', reason);
      if (this.page && !this.page.isClosed()) {
        await this.page.getByRole('button', { name: /leave call/i }).first().click({ timeout: 3000 }).catch(() => {});
      }
      await this.context?.close().catch(() => {});
      if (this.ffmpeg && this.ffmpeg.exitCode === null) {
        await new Promise((resolve) => {
          this.ffmpeg.on('close', resolve);
          this.ffmpeg.stdin.end();
        });
      } else {
        this.audio?.end();
      }
      if (this.ffmpeg && this.opts.mp3Path) this.opts.log('saved', path.resolve(this.opts.mp3Path));
      this.emit('ended', reason);
    })();
    return this.stopping;
  }
}

module.exports = { MeetBot, launchBrowser, DEFAULTS };
