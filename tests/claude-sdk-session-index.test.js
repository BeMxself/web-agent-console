import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkSessionIndex } from '../src/lib/claude-sdk-session-index.js';

test('claude session index persists threads and restores them by project', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const index = new ClaudeSdkSessionIndex({ filePath });
    await index.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: null,
      summary: 'Pending Claude thread',
      updatedAt: 5,
    });
    await index.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Materialized Claude thread',
      updatedAt: 10,
    });
    await index.upsertThread({
      threadId: 'thread-2',
      projectId: '/tmp/workspace-b',
      claudeSessionId: 'claude-session-2',
      summary: 'Other project thread',
      updatedAt: 7,
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.threads['thread-1'].claudeSessionId, 'claude-session-1');
    assert.equal(persisted.threads['thread-1'].projectId, '/tmp/workspace-a');

    const restoredIndex = new ClaudeSdkSessionIndex({ filePath });
    const thread = await restoredIndex.readThread('thread-1');
    const projectThreads = await restoredIndex.listThreadsByProject('/tmp/workspace-a');
    const threadIdsByProject = await restoredIndex.listThreadIdsByProject();

    assert.deepEqual(thread, {
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Materialized Claude thread',
      createdAt: 5,
      updatedAt: 10,
    });
    assert.deepEqual(projectThreads, [
      {
        threadId: 'thread-1',
        projectId: '/tmp/workspace-a',
        claudeSessionId: 'claude-session-1',
        summary: 'Materialized Claude thread',
        createdAt: 5,
        updatedAt: 10,
      },
    ]);
    assert.deepEqual(threadIdsByProject.get('/tmp/workspace-a'), ['thread-1']);
    assert.deepEqual(threadIdsByProject.get('/tmp/workspace-b'), ['thread-2']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('claude session index preserves both records when separate instances upsert sequentially', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-shared-file-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const indexA = new ClaudeSdkSessionIndex({ filePath });
    const indexB = new ClaudeSdkSessionIndex({ filePath });

    await indexA.load();
    await indexB.load();

    await indexA.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Thread one',
      updatedAt: 10,
    });
    await indexB.upsertThread({
      threadId: 'thread-2',
      projectId: '/tmp/workspace-b',
      claudeSessionId: 'claude-session-2',
      summary: 'Thread two',
      updatedAt: 20,
    });

    const restoredIndex = new ClaudeSdkSessionIndex({ filePath });
    const restoredThreadOne = await restoredIndex.readThread('thread-1');
    const restoredThreadTwo = await restoredIndex.readThread('thread-2');
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));

    assert.equal(restoredThreadOne?.claudeSessionId, 'claude-session-1');
    assert.equal(restoredThreadTwo?.claudeSessionId, 'claude-session-2');
    assert.deepEqual(Object.keys(persisted.threads).sort(), ['thread-1', 'thread-2']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('claude session index merges persisted threads before saving a stale cached snapshot', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-stale-save-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const indexA = new ClaudeSdkSessionIndex({ filePath });
    const indexB = new ClaudeSdkSessionIndex({ filePath });
    const staleSnapshot = await indexA.load();

    await indexB.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Thread one',
      updatedAt: 10,
    });

    staleSnapshot.threads['thread-2'] = {
      threadId: 'thread-2',
      projectId: '/tmp/workspace-b',
      claudeSessionId: 'claude-session-2',
      summary: 'Thread two',
      createdAt: 20,
      updatedAt: 20,
    };

    await indexA.save(staleSnapshot);

    const restoredIndex = new ClaudeSdkSessionIndex({ filePath });
    const restoredThreadOne = await restoredIndex.readThread('thread-1');
    const restoredThreadTwo = await restoredIndex.readThread('thread-2');
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));

    assert.equal(restoredThreadOne?.claudeSessionId, 'claude-session-1');
    assert.equal(restoredThreadTwo?.claudeSessionId, 'claude-session-2');
    assert.deepEqual(Object.keys(persisted.threads).sort(), ['thread-1', 'thread-2']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('claude session index preserves fresher same-thread data when a stale snapshot is saved later', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-stale-thread-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const indexA = new ClaudeSdkSessionIndex({ filePath });
    const indexB = new ClaudeSdkSessionIndex({ filePath });
    const staleSnapshot = await indexA.load();

    await indexB.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Fresh summary',
      createdAt: 10,
      updatedAt: 20,
    });

    staleSnapshot.threads['thread-1'] = {
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: null,
      summary: 'Stale summary',
      createdAt: 10,
      updatedAt: 10,
    };

    await indexA.save(staleSnapshot);

    const restoredIndex = new ClaudeSdkSessionIndex({ filePath });
    const restoredThread = await restoredIndex.readThread('thread-1');

    assert.deepEqual(restoredThread, {
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Fresh summary',
      createdAt: 10,
      updatedAt: 20,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('claude session index preserves fresher same-thread data when a stale thread is upserted later', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-stale-upsert-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const indexA = new ClaudeSdkSessionIndex({ filePath });
    const indexB = new ClaudeSdkSessionIndex({ filePath });

    await indexA.load();
    await indexB.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Fresh summary',
      createdAt: 10,
      updatedAt: 20,
    });

    await indexA.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: null,
      summary: 'Stale summary',
      createdAt: 10,
      updatedAt: 10,
    });

    const restoredIndex = new ClaudeSdkSessionIndex({ filePath });
    const restoredThread = await restoredIndex.readThread('thread-1');

    assert.deepEqual(restoredThread, {
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Fresh summary',
      createdAt: 10,
      updatedAt: 20,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('claude session index persists external bridge metadata', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-bridge-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const index = new ClaudeSdkSessionIndex({ filePath });
    await index.upsertThread({
      threadId: 'claude-thread-rogue',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'rogue-session',
      summary: 'External Claude session',
      bridgeMode: 'discovered',
      transcriptPath: '/tmp/.claude/projects/workspace-a/rogue-session.jsonl',
      lastSeenAt: 123,
      updatedAt: 123,
    });

    const stored = await index.readThread('claude-thread-rogue');
    const restored = await new ClaudeSdkSessionIndex({ filePath }).readThread('claude-thread-rogue');

    assert.equal(stored.bridgeMode, 'discovered');
    assert.equal(stored.transcriptPath, '/tmp/.claude/projects/workspace-a/rogue-session.jsonl');
    assert.equal(stored.lastSeenAt, 123);
    assert.equal(restored.bridgeMode, 'discovered');
    assert.equal(restored.transcriptPath, '/tmp/.claude/projects/workspace-a/rogue-session.jsonl');
    assert.equal(restored.lastSeenAt, 123);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('claude session index keeps the freshest bridge mode when external tracking degrades', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-index-bridge-mode-'));
  const filePath = join(tempDir, 'claude-session-index.json');

  try {
    const index = new ClaudeSdkSessionIndex({ filePath });
    await index.upsertThread({
      threadId: 'claude-thread-rogue',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'rogue-session',
      bridgeMode: 'hooked+tail',
      updatedAt: 100,
    });
    await index.upsertThread({
      threadId: 'claude-thread-rogue',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'rogue-session',
      bridgeMode: 'hooked',
      updatedAt: 200,
    });

    const stored = await index.readThread('claude-thread-rogue');

    assert.equal(stored.bridgeMode, 'hooked');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
