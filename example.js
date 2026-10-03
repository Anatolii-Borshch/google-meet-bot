// Usage: node example.js https://meet.google.com/xxx-xxxx-xxx
// Type "stop" + Enter (or Ctrl+C) to leave.
const fs = require('fs');
const readline = require('readline');
const { MeetBot } = require('./meet-recorder');

const url = process.argv[2];
if (!url) {
  console.log('Usage: node example.js <meet url>');
  process.exit(1);
}

const bot = new MeetBot({
  url,
  headless: process.env.HEADLESS === '1',
  authFile: fs.existsSync('auth.json') ? 'auth.json' : null,
  mp3Path: `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.mp3`,
  stream: { format: 's16le', sampleRate: 16000, channels: 1 },
});

// Live audio: replace this with your speech-to-text client
let bytes = 0;
bot.audio.on('data', (chunk) => { bytes += chunk.length; });
const stats = setInterval(() => console.log(`[stream] ${(bytes / 32000).toFixed(1)}s of audio received`), 10_000);

bot.on('waiting', () => console.log('waiting to be admitted...'));
bot.on('ended', (reason) => {
  clearInterval(stats);
  console.log('ended:', reason);
  process.exit(0);
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'stop') bot.stop('stop command');
});
process.on('SIGINT', () => bot.stop('Ctrl+C'));

bot.start().catch((err) => console.error('failed:', err.message));
