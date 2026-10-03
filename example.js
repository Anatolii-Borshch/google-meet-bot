// Usage: node example.js https://meet.google.com/xxx-xxxx-xxx
// Type "stop" + Enter (or Ctrl+C) to leave. Settings come from .env (see .env.example).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const readline = require('readline');
const { MeetBot } = require('./meet-recorder');
const { MeetingContext } = require('./meeting-context');
const { createTranscriber } = require('./transcribers');

const url = process.argv[2];
if (!url) {
  console.log('Usage: node example.js <meet url>');
  process.exit(1);
}

const config = {
  transcription: {
    provider: 'gemini', // see transcribers/index.js
    model: process.env.STT_MODEL || 'gemini-3.5-transcribe-live',
    apiKey: process.env.GEMINI_API_KEY,
    languages: (process.env.STT_LANGUAGES || '').split(',').filter(Boolean), // e.g. "en-US,uk-UA"; empty = auto
  },
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const meeting = new MeetingContext({ url, dir: `meetings/${stamp}` });
const stt = createTranscriber(config.transcription);

const bot = new MeetBot({
  url,
  headless: process.env.HEADLESS === '1',
  authFile: fs.existsSync('auth.json') ? 'auth.json' : null,
  mp3Path: `${meeting.dir}/recording.mp3`,
  stream: { format: 's16le', sampleRate: 16000, channels: 1 }, // bot.audio for other services
});
bot.audio.resume(); // not consumed in this example

bot.on('waiting', () => console.log('waiting to be admitted...'));
bot.on('joined', () => stt.start().catch((err) => console.error('[stt] start failed:', err.message)));
bot.on('pcm', (pcm) => stt.write(pcm));
bot.on('speakers', (s) => {
  meeting.updateSpeakers(s);
  if (s.speaking.length) console.log(`[speaking] ${s.speaking.join(', ')}`);
});

meeting.on('participant', (name) => console.log(`[participant] ${name}`));
stt.on('text', (t) => {
  const u = meeting.addText(t);
  console.log(`[${u.speaker}] ${t.text}`);
});
stt.on('log', (m) => console.log('[stt]', m));
stt.on('error', (err) => console.error('[stt] error:', err.message));

bot.on('ended', async (reason) => {
  console.log('ended:', reason);
  await stt.stop().catch(() => {});
  console.log('saved', meeting.save());
  process.exit(0);
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'stop') bot.stop('stop command');
});
process.on('SIGINT', () => bot.stop('Ctrl+C'));

bot.start().catch((err) => console.error('failed:', err.message));
