// Meeting context: who was there, who said what. Attributes transcript pieces to speakers
// using Meet's active-speaker timeline (both on the bot's audio clock, in seconds).
// Files in `dir`: transcript.jsonl (appended live), meeting.json + meeting.md (on save()).
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const UNKNOWN = 'Unknown';

class MeetingContext extends EventEmitter {
  constructor({ url = null, dir = `meetings/${new Date().toISOString().replace(/[:.]/g, '-')}`, mergeGapSec = 2 } = {}) {
    super();
    this.url = url;
    this.dir = dir;
    this.mergeGapSec = mergeGapSec; // same speaker continuing within this gap -> one utterance
    this.startedAt = new Date();
    this.participants = new Map(); // name -> { firstSeen, lastSeen } (audio clock)
    this.timeline = []; // { at, speaking: [names] }
    this.utterances = []; // { speaker, text, start, end }
    fs.mkdirSync(dir, { recursive: true });
    this.jsonl = path.join(dir, 'transcript.jsonl');
  }

  // From MeetBot 'speakers' event
  updateSpeakers({ speaking, present, at }) {
    for (const name of present) {
      const p = this.participants.get(name);
      if (p) p.lastSeen = at;
      else {
        this.participants.set(name, { firstSeen: at, lastSeen: at });
        this.emit('participant', name);
      }
    }
    const last = this.timeline[this.timeline.length - 1];
    if (!last || last.speaking.join('|') !== speaking.join('|')) this.timeline.push({ at, speaking });
  }

  // Name that was speaking longest within [start, end]; ties go to whoever started later
  speakerFor(start, end) {
    const totals = new Map();
    const lastStart = new Map();
    for (let i = 0; i < this.timeline.length; i++) {
      const { at, speaking } = this.timeline[i];
      const until = this.timeline[i + 1]?.at ?? end;
      const overlap = Math.min(until, end) - Math.max(at, start);
      if (overlap <= 0) continue;
      for (const name of speaking) {
        totals.set(name, (totals.get(name) || 0) + overlap);
        lastStart.set(name, at);
      }
    }
    let best = UNKNOWN;
    let bestTime = 0;
    for (const [name, time] of totals) {
      if (time > bestTime || (time === bestTime && lastStart.get(name) > lastStart.get(best))) {
        best = name;
        bestTime = time;
      }
    }
    return best;
  }

  // From a transcriber 'text' event; returns the (possibly merged) utterance
  addText({ text, start, end }) {
    const speaker = this.speakerFor(start, end);
    fs.appendFileSync(this.jsonl, JSON.stringify({ speaker, text, start: +start.toFixed(2), end: +end.toFixed(2) }) + '\n');
    const last = this.utterances[this.utterances.length - 1];
    let u;
    if (last && last.speaker === speaker && start - last.end <= this.mergeGapSec) {
      last.text += ' ' + text;
      last.end = end;
      u = last;
    } else {
      u = { speaker, text, start, end };
      this.utterances.push(u);
    }
    this.emit('utterance', u);
    return u;
  }

  byPerson() {
    const out = {};
    for (const u of this.utterances) (out[u.speaker] ||= []).push(u);
    return out;
  }

  toJSON() {
    return {
      url: this.url,
      startedAt: this.startedAt.toISOString(),
      participants: Object.fromEntries(this.participants),
      utterances: this.utterances,
      byPerson: this.byPerson(),
    };
  }

  save() {
    fs.writeFileSync(path.join(this.dir, 'meeting.json'), JSON.stringify(this.toJSON(), null, 2));
    const clock = (s) => new Date(s * 1000).toISOString().slice(11, 19);
    const md = [
      `# Meeting ${this.startedAt.toISOString()}`,
      this.url ? `URL: ${this.url}` : '',
      `Participants: ${[...this.participants.keys()].join(', ') || '-'}`,
      '',
      '## Transcript',
      ...this.utterances.map((u) => `**[${clock(u.start)}] ${u.speaker}:** ${u.text}`),
      '',
      '## By person',
      ...Object.entries(this.byPerson()).flatMap(([name, list]) => ['', `### ${name}`, ...list.map((u) => `- [${clock(u.start)}] ${u.text}`)]),
    ];
    fs.writeFileSync(path.join(this.dir, 'meeting.md'), md.join('\n') + '\n');
    return this.dir;
  }
}

module.exports = { MeetingContext, UNKNOWN };
