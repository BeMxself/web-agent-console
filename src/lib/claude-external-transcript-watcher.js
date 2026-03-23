import { readFile } from 'node:fs/promises';
import { ClaudeSdkEventMapper } from './claude-sdk-event-mapper.js';

const DEFAULT_POLL_INTERVAL_MS = 100;

export class ClaudeExternalTranscriptWatcher {
  constructor({
    threadId,
    turnId,
    projectId = null,
    transcriptPath,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onEvents = null,
    onError = null,
    readTranscript = async (filePath) => await readFile(filePath, 'utf8'),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.threadId = threadId;
    this.turnId = turnId;
    this.projectId = projectId;
    this.transcriptPath = transcriptPath;
    this.pollIntervalMs = pollIntervalMs;
    this.onEvents = onEvents;
    this.onError = onError;
    this.readTranscript = readTranscript;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.mapper = new ClaudeSdkEventMapper({
      threadId,
      turnId,
      projectId,
    });
    this.timer = null;
    this.processedLineCount = 0;
    this.stopped = false;
  }

  async start() {
    const initialContents = await this.readTranscript(this.transcriptPath);
    this.processedLineCount = splitTranscriptLines(initialContents).length;
    this.timer = this.setIntervalFn(() => {
      void this.poll();
    }, this.pollIntervalMs);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  async poll() {
    if (this.stopped) {
      return;
    }

    try {
      const contents = await this.readTranscript(this.transcriptPath);
      const lines = splitTranscriptLines(contents);
      if (lines.length < this.processedLineCount) {
        this.processedLineCount = 0;
      }

      const nextLines = lines.slice(this.processedLineCount);
      if (!nextLines.length) {
        return;
      }

      this.processedLineCount = lines.length;
      const events = [];
      for (const line of nextLines) {
        const mappedEvents = this.mapper
          .map(JSON.parse(line))
          .filter((event) => event?.type !== 'turn_completed');
        events.push(...mappedEvents);
      }

      if (events.length > 0) {
        this.onEvents?.(events);
      }
    } catch (error) {
      this.stop();
      this.onError?.(error);
    }
  }
}

function splitTranscriptLines(contents) {
  return String(contents ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
