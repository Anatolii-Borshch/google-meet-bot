// Gemini Live API transcription (gemini-3.5-transcribe-live). No timestamps or diarization in
// live mode, so timing comes from the base class audio clock.
const { GoogleGenAI, Modality } = require('@google/genai');
const { Transcriber, RATE } = require('./index');

class GeminiLiveTranscriber extends Transcriber {
  constructor(options) {
    super({ model: 'gemini-3.5-transcribe-live', languages: [], ...options });
    const apiKey = this.opts.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Gemini API key missing (apiKey option or GEMINI_API_KEY)');
    this.ai = new GoogleGenAI({ apiKey });
    this.session = null;
  }

  async connect() {
    this.session = await this.ai.live.connect({
      model: this.opts.model,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: { languageCodes: this.opts.languages },
      },
      callbacks: {
        onmessage: (msg) => this.onMessage(msg),
        onerror: (e) => this.emit('error', e.error || new Error(e.message || 'gemini live error')),
        onclose: (e) => {
          this.session = null;
          if (this.stopped) return;
          // sessions are time-limited: reconnect and keep streaming
          this.emit('log', `gemini session closed (${e?.reason || e?.code || 'no reason'}), reconnecting`);
          setTimeout(() => this.connect().catch((err) => this.emit('error', err)), 1000);
        },
      },
    });
    this.emit('log', `gemini connected (${this.opts.model})`);
  }

  send(pcm) {
    this.session?.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${RATE}` } });
  }

  onMessage(msg) {
    const c = msg.serverContent;
    if (c?.interimInputTranscription?.text) this.interim(c.interimInputTranscription.text);
    if (c?.inputTranscription?.text) this.text(c.inputTranscription.text);
  }

  async close() {
    if (!this.session) return;
    this.session.sendRealtimeInput({ audioStreamEnd: true });
    await new Promise((r) => setTimeout(r, 2000)); // let the last final transcript arrive
    this.session?.close();
  }
}

module.exports = GeminiLiveTranscriber;
