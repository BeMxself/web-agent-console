import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/lib/runtime-store.js';

test('runtime store persists thread settings and pending actions', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const store = new RuntimeStore({ filePath });
    await store.setApprovalMode('auto-approve');
    await store.setThreadSettings('thread-1', {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });
    await store.setApproval('approval-1', {
      id: 'approval-1',
      threadId: 'thread-1',
      status: 'pending',
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));

    assert.equal(persisted.approvalMode, 'auto-approve');
    assert.deepEqual(persisted.threadSettings['thread-1'], {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });
    assert.equal(persisted.pendingActions['approval-1'].threadId, 'thread-1');
    assert.equal(persisted.pendingActions['approval-1'].kind, 'tool_approval');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime store recovers from a corrupted persistence file', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');
  const corrupted = [
    '{',
    '  "version": 2,',
    '  "approvalMode": "manual",',
    '  "pendingActions": {},',
    '  "threads": {}',
    '}',
    '"dangling-thread": {',
    '  "turnStatus": "started"',
    '}',
  ].join('\n');

  try {
    await writeFile(filePath, corrupted, 'utf8');

    const store = new RuntimeStore({ filePath });
    const snapshot = await store.load();
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    const backups = (await readdir(tempDir)).filter((name) =>
      name.startsWith('runtime-store.json.corrupt-'),
    );

    assert.deepEqual(snapshot, {
      version: 4,
      approvalMode: 'auto-approve',
      pendingActions: {},
      threads: {},
      threadSettings: {},
    });
    assert.deepEqual(persisted, {
      version: 4,
      approvalMode: 'auto-approve',
      pendingActions: {},
      threads: {},
      threadSettings: {},
    });
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(tempDir, backups[0]), 'utf8'), corrupted);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime store migrates legacy manual approval mode snapshots to auto-approve', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: 2,
          approvalMode: 'manual',
          pendingActions: {},
          threads: {},
          threadSettings: {},
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const store = new RuntimeStore({ filePath });
    const snapshot = await store.load();

    assert.deepEqual(snapshot, {
      version: 4,
      approvalMode: 'auto-approve',
      pendingActions: {},
      threads: {},
      threadSettings: {},
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime store migrates legacy approvals into provider-agnostic pending actions', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: 3,
          approvalMode: 'manual',
          approvals: {
            'approval-1': {
              id: 'approval-1',
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              kind: 'commandExecution',
              summary: 'Run npm test',
              detail: {
                command: ['npm', 'test'],
                cwd: '/tmp/workspace-a',
              },
              status: 'pending',
              createdAt: 10,
              resolvedAt: null,
              resolutionSource: null,
            },
          },
          threads: {},
          threadSettings: {},
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const store = new RuntimeStore({ filePath });
    const snapshot = await store.load();

    assert.equal(snapshot.pendingActions['approval-1'].kind, 'tool_approval');
    assert.equal(snapshot.pendingActions['approval-1'].payload.approvalKind, 'commandExecution');
    assert.equal(snapshot.pendingActions['approval-1'].summary, 'Run npm test');
    assert.deepEqual(snapshot.pendingActions['approval-1'].payload.detail, {
      command: ['npm', 'test'],
      cwd: '/tmp/workspace-a',
    });
    assert.equal(snapshot.approvalMode, 'manual');
    assert.equal(snapshot.version, 4);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime store keeps manual approval mode for modern snapshots', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: 3,
          approvalMode: 'manual',
          pendingActions: {},
          threads: {},
          threadSettings: {},
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const store = new RuntimeStore({ filePath });
    const snapshot = await store.load();

    assert.deepEqual(snapshot, {
      version: 4,
      approvalMode: 'manual',
      pendingActions: {},
      threads: {},
      threadSettings: {},
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runtime store preserves claude-hook as an external runtime source', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const store = new RuntimeStore({ filePath });
    await store.setThreadRuntime('thread-hooked', {
      turnStatus: 'started',
      activeTurnId: 'external-turn-session-1',
      source: 'claude-hook',
      realtime: {
        status: 'started',
        sessionId: 'session-1',
        items: [],
      },
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    const reloaded = await new RuntimeStore({ filePath }).load();

    assert.equal(persisted.threads['thread-hooked'].source, 'claude-hook');
    assert.equal(reloaded.threads['thread-hooked'].source, 'claude-hook');
    assert.equal(reloaded.threads['thread-hooked'].activeTurnId, 'external-turn-session-1');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
