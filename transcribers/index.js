// Speech-to-text adapter interface. Every provider extends Transcriber and implements:
//   async connect()     open the provider session
//   send(pcm16k)        receive 16 kHz mono s16le Buffer
//   async close()       flush and close
// and reports results via this.text(text) / this.interim(text). The base class handles
// resampling from the bot's 48 kHz audio and the audio clock used for speaker attribution.
//
// Events: 'text' { text, start, end } (seconds on the bot's audio clock), 'interim' { text },
//         'error' Error, 'log' string
const { EventEmitter } = require('events');

const RATE = 16000;

class Transcriber extends EventEmitter {
  constructor(options = {}) {
    super();
    this.opts = options;
    this.samples = 0; // 16 kHz samples sent so far
    this.rest = Buffer.alloc(0); // leftover 48 kHz bytes not divisible into 3-sample groups
    this.segmentStart = null;
    this.lastEnd = 0;
    this.stopped = false;
  }

  time() {
    return this.samples / RATE;
  }

  async start() {
    await this.connect();
  }

  // 48 kHz mono s16le -> 16 kHz by averaging every 3 samples
  write(pcm48) {
    if (this.stopped) return;
    const buf = this.rest.length ? Buffer.concat([this.rest, pcm48]) : pcm48;
    const groups = Math.floor(buf.length / 6);
    const out = Buffer.alloc(groups * 2);
    for (let i = 0; i < groups; i++) {
      const o = i * 6;
      out.writeInt16LE(Math.round((buf.readInt16LE(o) + buf.readInt16LE(o + 2) + buf.readInt16LE(o + 4)) / 3), i * 2);
    }
    this.rest = buf.subarray(groups * 6);
    this.samples += groups;
    if (groups) this.send(out);
  }

  // Providers without timestamps: a segment starts shortly before its first interim result
  interim(text) {
    if (this.segmentStart === null) this.segmentStart = Math.max(this.lastEnd, this.time() - 1.5);
    this.emit('interim', { text });
  }

  text(text, start, end) {
    if (!text || !text.trim()) return;
    end ??= this.time();
    start ??= this.segmentStart ?? Math.max(this.lastEnd, end - 5);
    this.segmentStart = null;
    this.lastEnd = end;
    this.emit('text', { text: text.trim(), start, end });
  }

  async stop() {
    this.stopped = true;
    await this.close();
  }

  connect() { throw new Error('connect() not implemented'); }
  send() { throw new Error('send() not implemented'); }
  async close() {}
}

const providers = {
  gemini: () => require('./gemini-live'),
};

// config: { provider: 'gemini', model, apiKey, languages: ['en-US'], ... provider-specific }
function createTranscriber(config) {
  const load = providers[config.provider];
  if (!load) throw new Error(`unknown transcription provider "${config.provider}" (available: ${Object.keys(providers).join(', ')})`);
  const Provider = load();
  return new Provider(config);
}

module.exports = { Transcriber, createTranscriber, providers, RATE };
