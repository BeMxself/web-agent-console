import { loadJsonSnapshotFile, writeJsonSnapshotFile } from './json-file-store.js';

const SNAPSHOT_VERSION = 1;
const EMPTY_SNAPSHOT = Object.freeze({
  version: SNAPSHOT_VERSION,
  threads: {},
});

export class ClaudeSdkSessionIndex {
  constructor({ filePath } = {}) {
    this.filePath = filePath ?? null;
    this.snapshot = null;
  }

  async load() {
    if (this.snapshot) {
      return this.snapshot;
    }

    if (!this.filePath) {
      this.snapshot = normalizeSnapshot(EMPTY_SNAPSHOT);
      return this.snapshot;
    }

    this.snapshot = await loadJsonSnapshotFile({
      filePath: this.filePath,
      emptySnapshot: EMPTY_SNAPSHOT,
      normalizeSnapshot,
    });
    return this.snapshot;
  }

  async upsertThread(thread) {
    const snapshot = await this.loadLatest();
    const normalizedThread = mergeThreadRecords(
      snapshot.threads[thread?.threadId] ?? null,
      thread,
    );

    snapshot.threads[normalizedThread.threadId] = normalizedThread;
    await this.save(snapshot);
    return normalizedThread;
  }

  async readThread(threadId) {
    const snapshot = await this.load();
    return snapshot.threads[threadId] ?? null;
  }

  async listThreadsByProject(projectId) {
    const snapshot = await this.load();
    return Object.values(snapshot.threads)
      .filter((thread) => thread.projectId === projectId)
      .sort(compareThreads);
  }

  async listThreadIdsByProject() {
    const snapshot = await this.load();
    const idsByProject = new Map();

    for (const thread of Object.values(snapshot.threads).sort(compareThreads)) {
      if (!thread.projectId) {
        continue;
      }

      if (!idsByProject.has(thread.projectId)) {
        idsByProject.set(thread.projectId, []);
      }

      idsByProject.get(thread.projectId).push(thread.threadId);
    }

    return idsByProject;
  }

  async deleteThread(threadId) {
    const snapshot = await this.loadLatest();
    if (!snapshot.threads[threadId]) {
      return false;
    }

    delete snapshot.threads[threadId];
    const normalized = normalizeSnapshot(snapshot);
    if (this.filePath) {
      await writeJsonSnapshotFile(this.filePath, normalized);
    }
    this.snapshot = normalized;
    return true;
  }

  async save(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    const merged = this.filePath
      ? mergeSnapshots(
          await loadJsonSnapshotFile({
            filePath: this.filePath,
            emptySnapshot: EMPTY_SNAPSHOT,
            normalizeSnapshot,
          }),
          this.snapshot,
          normalized,
        )
      : normalized;

    if (this.filePath) {
      await writeJsonSnapshotFile(this.filePath, merged);
    }
    this.snapshot = merged;
    return merged;
  }

  async loadLatest() {
    if (!this.filePath) {
      return await this.load();
    }

    this.snapshot = await loadJsonSnapshotFile({
      filePath: this.filePath,
      emptySnapshot: EMPTY_SNAPSHOT,
      normalizeSnapshot,
    });
    return this.snapshot;
  }
}

function normalizeSnapshot(snapshot) {
  const threads = {};

  for (const [threadId, thread] of Object.entries(snapshot?.threads ?? {})) {
    const normalizedThread = normalizeThread({
      ...thread,
      threadId,
    });
    if (!normalizedThread.threadId) {
      continue;
    }
    threads[normalizedThread.threadId] = normalizedThread;
  }

  return {
    version: SNAPSHOT_VERSION,
    threads,
  };
}

function mergeSnapshots(...snapshots) {
  const threads = {};

  snapshots.forEach((snapshot, snapshotIndex) => {
    const normalizedSnapshot = normalizeSnapshot(snapshot);
    Object.entries(normalizedSnapshot.threads).forEach(([threadId, thread]) => {
      threads[threadId] = mergeThreadRecords(
        threads[threadId] ?? null,
        {
          ...thread,
          // Later snapshots should win ties when freshness is equal.
          __mergeOrder: snapshotIndex,
        },
      );
    });
  });

  return {
    version: SNAPSHOT_VERSION,
    threads,
  };
}

function mergeThreadRecords(...threads) {
  const normalizedThreads = threads
    .map((thread, index) => {
      const normalizedThread = normalizeThread(thread);
      if (!normalizedThread.threadId) {
        return null;
      }

      return {
        ...normalizedThread,
        __mergeOrder: Number.isFinite(thread?.__mergeOrder) ? thread.__mergeOrder : index,
      };
    })
    .filter(Boolean);

  if (!normalizedThreads.length) {
    return normalizeThread({});
  }

  const freshestFirst = [...normalizedThreads].sort(compareThreadFreshness);
  const createdAt = pickEarliestTimestamp(normalizedThreads.map((thread) => thread.createdAt));
  const updatedAt = pickLatestTimestamp([
    ...normalizedThreads.map((thread) => thread.updatedAt),
    createdAt,
  ]);

  return {
    threadId: freshestFirst[0].threadId,
    projectId: pickFirstNonNull(freshestFirst.map((thread) => thread.projectId)),
    claudeSessionId: pickFirstNonNull(freshestFirst.map((thread) => thread.claudeSessionId)),
    summary: pickFirstNonNull(freshestFirst.map((thread) => thread.summary)),
    ...(pickFirstNonNull(freshestFirst.map((thread) => thread.bridgeMode))
      ? { bridgeMode: pickFirstNonNull(freshestFirst.map((thread) => thread.bridgeMode)) }
      : {}),
    ...(pickFirstNonNull(freshestFirst.map((thread) => thread.transcriptPath))
      ? { transcriptPath: pickFirstNonNull(freshestFirst.map((thread) => thread.transcriptPath)) }
      : {}),
    ...(pickLatestTimestamp(normalizedThreads.map((thread) => thread.lastSeenAt))
      ? { lastSeenAt: pickLatestTimestamp(normalizedThreads.map((thread) => thread.lastSeenAt)) }
      : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeThread(thread) {
  const threadId = normalizeString(thread?.threadId);
  const projectId = normalizeString(thread?.projectId);
  const createdAt = normalizeTimestamp(thread?.createdAt ?? thread?.updatedAt);
  const updatedAt = normalizeTimestamp(thread?.updatedAt ?? createdAt);
  const bridgeMode = normalizeBridgeMode(thread?.bridgeMode);
  const transcriptPath = normalizeString(thread?.transcriptPath);
  const lastSeenAt = normalizeTimestamp(thread?.lastSeenAt);

  return {
    threadId,
    projectId,
    claudeSessionId: normalizeString(thread?.claudeSessionId),
    summary: normalizeString(thread?.summary),
    ...(bridgeMode ? { bridgeMode } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeBridgeMode(value) {
  const normalized = normalizeString(value);
  if (normalized === 'discovered' || normalized === 'hooked' || normalized === 'hooked+tail') {
    return normalized;
  }

  return null;
}

function normalizeString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function pickFirstNonNull(values) {
  for (const value of values) {
    if (value != null) {
      return value;
    }
  }

  return null;
}

function pickEarliestTimestamp(values) {
  const timestamps = values.filter((value) => value > 0);
  return timestamps.length ? Math.min(...timestamps) : 0;
}

function pickLatestTimestamp(values) {
  const timestamps = values.filter((value) => value > 0);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function compareThreadFreshness(left, right) {
  if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  }

  if ((right.createdAt ?? 0) !== (left.createdAt ?? 0)) {
    return (right.createdAt ?? 0) - (left.createdAt ?? 0);
  }

  return (right.__mergeOrder ?? 0) - (left.__mergeOrder ?? 0);
}

function compareThreads(left, right) {
  if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  }

  return (left.threadId ?? '').localeCompare(right.threadId ?? '');
}
