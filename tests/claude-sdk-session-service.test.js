import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkSessionIndex } from '../src/lib/claude-sdk-session-index.js';
import { ClaudeSdkSessionService } from '../src/lib/claude-sdk-session-service.js';
import { SessionService } from '../src/lib/session-service.js';
import { RuntimeStore } from '../src/lib/runtime-store.js';
import { createFakeClaudeSdk } from './helpers/fake-claude-sdk.js';

test('ClaudeSdkSessionService extends the shared SessionService core', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-inheritance-'));

  try {
    const service = new ClaudeSdkSessionService({
      activityStore: createMemoryActivityStore(),
      sessionIndex: new ClaudeSdkSessionIndex({
        filePath: join(tempDir, 'claude-session-index.json'),
      }),
      runtimeStore: new RuntimeStore({
        filePath: join(tempDir, 'claude-runtime-store.json'),
      }),
    });

    assert.equal(service instanceof SessionService, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ClaudeSdkSessionService delegates shared thread decoration to shared SessionService helpers', async () => {
  const source = await readFile(
    new URL('../src/lib/claude-sdk-session-service.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /decorateThreadWithSharedState/);
  for (const duplicatedHelper of [
    'function attachRuntimeSnapshot(',
    'function attachSessionSettings(',
    'function attachPendingActionSnapshot(',
    'function normalizeRuntimeSnapshot(',
    'function createStartedRuntimeSnapshot(',
    'function createInterruptingRuntimeSnapshot(',
    'function createInterruptedRuntimeSnapshot(',
    'function createErroredRuntimeSnapshot(',
    'function createCompletedRuntimeSnapshot(',
    'function updateRuntimeSessionId(',
    'function clonePendingQuestionRecord(',
    'function createDefaultSessionSettings(',
    'function normalizeSessionSettings(',
    'function cloneSessionSettings(',
    'function nowInSeconds(',
  ]) {
    assert.equal(
      source.includes(duplicatedHelper),
      false,
      `expected shared helper to be removed from claude-sdk-session-service.js: ${duplicatedHelper}`,
    );
  }
});

test('first Claude turn materializes sdk session id under an app-owned thread id', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponses: [
      [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-session-1',
        },
        createSuccessResultMessage({
          sessionId: 'claude-session-1',
          uuid: 'result-1',
          result: 'Done',
        }),
      ],
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    const beforeTurn = JSON.parse(await readFile(filePath, 'utf8'));

    assert.equal(beforeTurn.threads[created.thread.id].claudeSessionId, null);

    const result = await service.startTurn(created.thread.id, 'Hello Claude');

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.match(result.turnId, /^turn-/);
    assert.equal(result.status, 'started');
    assert.equal(persisted.threads[created.thread.id].claudeSessionId, 'claude-session-1');
    assert.equal(fakeClaudeSdk.calls.query.length, 1);
    const firstPromptMessage = await readFirstPromptMessage(fakeClaudeSdk.calls.query[0].prompt);
    assert.deepEqual(firstPromptMessage.message, {
      role: 'user',
      content: [{ type: 'text', text: 'Hello Claude' }],
    });
    assert.equal(fakeClaudeSdk.calls.query[0].options.cwd, '/tmp/workspace-a');
    assert.equal(fakeClaudeSdk.calls.query[0].options.includePartialMessages, true);
    assert.deepEqual(fakeClaudeSdk.calls.query[0].options.settingSources, [
      'user',
      'project',
      'local',
    ]);
    assert.equal(typeof fakeClaudeSdk.calls.query[0].options.abortController?.abort, 'function');
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude startTurn sends async-iterable SDK user prompt with text, image, pdf, and text-document blocks', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-attachments-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponses: [
      [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-session-attachments',
        },
        createSuccessResultMessage({
          sessionId: 'claude-session-attachments',
          uuid: 'result-1',
          result: 'Done',
        }),
      ],
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    const result = await service.startTurn(created.thread.id, {
      text: 'Review the uploaded files',
      model: 'opus',
      reasoningEffort: 'high',
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
        },
        {
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 4,
          dataBase64: 'YmFy',
        },
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          dataBase64: 'aGVsbG8=',
        },
      ],
    });

    assert.equal(result.status, 'started');
    assert.equal(fakeClaudeSdk.calls.query.length, 1);
    assert.equal(fakeClaudeSdk.calls.query[0].options.model, 'opus');
    assert.equal(fakeClaudeSdk.calls.query[0].options.effort, 'high');
    const firstPromptMessage = await readFirstPromptMessage(fakeClaudeSdk.calls.query[0].prompt);
    assert.equal(firstPromptMessage.type, 'user');
    assert.equal(firstPromptMessage.parent_tool_use_id, null);
    assert.deepEqual(firstPromptMessage.message, {
      role: 'user',
      content: [
        { type: 'text', text: 'Review the uploaded files' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'Zm9v',
          },
        },
        {
          type: 'document',
          title: 'report.pdf',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'YmFy',
          },
        },
        {
          type: 'document',
          title: 'notes.txt',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: 'hello',
          },
        },
      ],
    });
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude startTurn rejects unsupported binary attachments before query starts', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-unsupported-attachments-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const fakeClaudeSdk = createFakeClaudeSdk();
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({
    filePath: runtimeStorePath,
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    await assert.rejects(
      service.startTurn(created.thread.id, {
        text: 'Process this archive',
        attachments: [
          {
            name: 'archive.zip',
            mimeType: 'application/zip',
            size: 3,
            dataBase64: 'Zm9v',
          },
        ],
      }),
      /only supports image, text, and pdf attachments/i,
    );
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'errored',
      ),
    );

    const persistedRuntime = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(fakeClaudeSdk.calls.query.length, 0);
    assert.equal(persistedRuntime.threads[created.thread.id].turnStatus, 'errored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn returns after session id materializes while the Claude stream keeps running in the background', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-early-return-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  let streamCompleted = false;
  const gate = createDeferred();
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-early',
          };
          await gate.promise;
          yield createSuccessResultMessage({
            sessionId: 'claude-session-early',
            uuid: 'result-1',
            result: 'Done',
          });
          streamCompleted = true;
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await Promise.race([
      service.startTurn(created.thread.id, 'Hello Claude'),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('startTurn did not return after session id materialized')), 100);
      }),
    ]);

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(result.thread.id, created.thread.id);
    assert.equal(result.status, 'started');
    assert.equal(persisted.threads[created.thread.id].claudeSessionId, 'claude-session-early');
    assert.equal(streamCompleted, false);

    gate.resolve();
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));
    assert.equal(streamCompleted, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readSession maps Claude transcript attachments into lightweight user attachment summary blocks', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-transcript-attachments-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const fakeClaudeSdk = createFakeClaudeSdk({
    sessionInfoById: {
      'claude-session-attachments': {
        sessionId: 'claude-session-attachments',
        summary: 'Attachment thread',
        createdAt: Date.now(),
        lastModified: Date.now(),
      },
    },
    sessionMessagesById: {
      'claude-session-attachments': [
        {
          type: 'user',
          uuid: 'user-1',
          session_id: 'claude-session-attachments',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Please review these files' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'Zm9v' },
              },
              {
                type: 'document',
                title: 'report.pdf',
                source: { type: 'base64', media_type: 'application/pdf', data: 'YmFy' },
              },
              {
                type: 'document',
                title: 'notes.txt',
                source: { type: 'text', media_type: 'text/plain', data: 'hello' },
              },
            ],
          },
        },
      ],
    },
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    await sessionIndex.upsertThread({
      threadId: created.thread.id,
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-attachments',
      summary: 'Attachment thread',
      createdAt: 100,
      updatedAt: 100,
    });

    const detail = await service.readSession(created.thread.id);
    assert.deepEqual(detail.thread.turns[0].items[0].content, [
      {
        type: 'text',
        text: 'Please review these files',
        text_elements: [],
      },
      {
        type: 'attachmentSummary',
        attachmentType: 'image',
        mimeType: 'image/png',
        name: null,
      },
      {
        type: 'attachmentSummary',
        attachmentType: 'pdf',
        mimeType: 'application/pdf',
        name: 'report.pdf',
      },
      {
        type: 'attachmentSummary',
        attachmentType: 'text',
        mimeType: 'text/plain',
        name: 'notes.txt',
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn rejects synchronous Claude query startup failures and reconciles runtime as errored', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-sync-failure-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => {
        throw new Error('Claude SDK failed before streaming');
      },
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    await assert.rejects(
      Promise.race([
        service.startTurn(created.thread.id, 'Hello Claude'),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('startTurn did not reject after synchronous startup failure')), 100);
        }),
      ]),
      /Claude SDK failed before streaming/,
    );

    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'errored',
      ),
    );

    const persistedRuntime = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persistedRuntime.threads[created.thread.id].turnStatus, 'errored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn rejects synchronous Claude query startup failures for resumed Claude sessions', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-sync-failure-resume-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => {
        throw new Error('Claude SDK resume failed before streaming');
      },
    ],
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    await sessionIndex.upsertThread({
      threadId: created.thread.id,
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-existing',
      summary: 'Existing Claude thread',
      createdAt: 100,
      updatedAt: 100,
    });
    const events = [];
    service.subscribe((event) => events.push(event));

    await assert.rejects(
      Promise.race([
        service.startTurn(created.thread.id, 'Resume Claude'),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('startTurn did not reject for resumed session startup failure')), 1000);
        }),
      ]),
      /Claude SDK resume failed before streaming/,
    );

    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'errored',
      ),
    );

    const persistedRuntime = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persistedRuntime.threads[created.thread.id].turnStatus, 'errored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn rejects when resumed-session turn setup throws before Claude query starts', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-pre-query-failure-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const fakeClaudeSdk = createFakeClaudeSdk();
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });
  const turnSettings = {
    get model() {
      throw new Error('Claude turn setup failed before query');
    },
  };

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    await sessionIndex.upsertThread({
      threadId: created.thread.id,
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-existing',
      summary: 'Existing Claude thread',
      createdAt: 100,
      updatedAt: 100,
    });
    const events = [];
    service.subscribe((event) => events.push(event));

    await assert.rejects(
      Promise.race([
        service.startTurn(created.thread.id, 'Resume Claude', turnSettings),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('startTurn did not reject for resumed session pre-query failure')), 1000);
        }),
      ]),
      /Claude turn setup failed before query/,
    );

    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'errored',
      ),
    );

    const persistedRuntime = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(fakeClaudeSdk.calls.query.length, 0);
    assert.equal(persistedRuntime.threads[created.thread.id].turnStatus, 'errored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude session service exposes session options and persists per-session settings', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-settings-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    assert.deepEqual(await service.getSessionOptions(), {
      modelOptions: [
        { value: '', label: '默认' },
        { value: 'sonnet', label: 'sonnet' },
        { value: 'opus', label: 'opus' },
        { value: 'haiku', label: 'haiku' },
      ],
      reasoningEffortOptions: [
        { value: '', label: '默认' },
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
      ],
      defaults: {
        model: null,
        reasoningEffort: null,
      },
    });
    assert.deepEqual(await service.getSessionSettings('thread-cl-001'), {
      model: null,
      reasoningEffort: null,
    });

    assert.deepEqual(
      await service.setSessionSettings('thread-cl-001', {
        model: 'sonnet',
        reasoningEffort: 'high',
      }),
      {
        model: 'sonnet',
        reasoningEffort: 'high',
      },
    );

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.deepEqual(persisted.threadSettings['thread-cl-001'], {
      model: 'sonnet',
      reasoningEffort: 'high',
    });

    const reloadedService = new ClaudeSdkSessionService({
      activityStore: createMemoryActivityStore(),
      claudeSdk: createFakeClaudeSdk(),
      runtimeStore: new RuntimeStore({ filePath: runtimeStorePath }),
      cwd: '/tmp/default-cwd',
      sessionIndex,
    });
    assert.deepEqual(await reloadedService.getSessionSettings('thread-cl-001'), {
      model: 'sonnet',
      reasoningEffort: 'high',
    });

    assert.deepEqual(
      await service.setSessionSettings('thread-cl-001', {
        model: null,
        reasoningEffort: null,
      }),
      {
        model: null,
        reasoningEffort: null,
      },
    );

    const cleared = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(cleared.threadSettings['thread-cl-001'], undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude session service renames a session via the SDK and keeps the renamed title on reload', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-rename-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    sessionInfoById: {
      'claude-session-rename': {
        sessionId: 'claude-session-rename',
        summary: 'Original Claude Summary',
        lastModified: 1710000000000,
        customTitle: 'Original Claude Summary',
      },
    },
    sessionMessagesById: {
      'claude-session-rename': [
        {
          type: 'user',
          uuid: 'user-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Inspect the repo' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Working on it.' }],
          },
        },
      ],
    },
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore: new RuntimeStore({
      filePath: join(tempDir, 'claude-runtime-store.json'),
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    await sessionIndex.upsertThread({
      threadId: created.thread.id,
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-rename',
      summary: 'Original Claude Summary',
      createdAt: 1710000000,
      updatedAt: 1710000000,
    });

    const renamed = await service.renameSession(created.thread.id, '  Renamed Claude Session  ');

    assert.equal(renamed.thread.id, created.thread.id);
    assert.equal(renamed.thread.name, 'Renamed Claude Session');
    assert.equal(renamed.thread.preview, 'Inspect the repo');
    assert.deepEqual(fakeClaudeSdk.calls.renameSession, [
      {
        sessionId: 'claude-session-rename',
        title: 'Renamed Claude Session',
        options: { dir: '/tmp/workspace-a' },
      },
    ]);

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.threads[created.thread.id].summary, 'Renamed Claude Session');

    const reloaded = await service.readSession(created.thread.id);
    assert.equal(reloaded.thread.name, 'Renamed Claude Session');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionStart hook materializes a known-project external Claude session as running', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-start-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'external-session-1',
        cwd: '/tmp/workspace-a',
        transcript_path: '/tmp/transcripts/external-session-1.jsonl',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.thread.id, 'claude-thread-external-session-1');
    assert.equal(result.thread.runtime.turnStatus, 'started');
    assert.equal(result.thread.runtime.source, 'claude-hook');
    assert.equal(result.thread.runtime.realtime.sessionId, 'external-session-1');
    assert.equal(result.thread.external.bridgeMode, 'hooked');
    assert.equal(result.thread.external.transcriptPath, '/tmp/transcripts/external-session-1.jsonl');
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.threadId === 'claude-thread-external-session-1' &&
          event.payload.runtime.source === 'claude-hook' &&
          event.payload.runtime.turnStatus === 'started',
      ),
    );
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'thread_status_changed' &&
          event.threadId === 'claude-thread-external-session-1' &&
          event.payload.status.type === 'active',
      ),
    );

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persisted.threads['claude-thread-external-session-1'].source, 'claude-hook');
    assert.equal(persisted.threads['claude-thread-external-session-1'].turnStatus, 'started');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('PermissionRequest hook creates a pending approval for an external Claude session', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-approval-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.setApprovalMode('manual');

    const result = await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'PermissionRequest',
        session_id: 'external-session-approval',
        cwd: '/tmp/workspace-a',
        transcript_path: '/tmp/transcripts/external-session-approval.jsonl',
        tool_name: 'Bash',
        tool_use_id: 'toolu-1',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.thread.id, 'claude-thread-external-session-approval');
    assert.equal(result.thread.pendingApprovalCount, 1);
    assert.equal(result.thread.runtime.source, 'claude-hook');
    assert.equal(service.listPendingApprovals('claude-thread-external-session-approval').length, 1);
    assert.equal(
      service.listPendingApprovals('claude-thread-external-session-approval')[0].summary,
      'Allow Bash usage',
    );
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'approval_requested' &&
          event.threadId === 'claude-thread-external-session-approval' &&
          event.payload.approval.summary === 'Allow Bash usage',
      ),
    );

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    const actionId = service.listPendingApprovals('claude-thread-external-session-approval')[0].id;
    assert.equal(persisted.pendingActions[actionId].status, 'pending');
    assert.equal(persisted.pendingActions[actionId].payload.toolUseId, 'toolu-1');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('PermissionRequest hook honors shared auto-approve mode for waiting external Claude approvals', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-approval-auto-approve-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const result = await service.ingestExternalBridgeEvent({
      provider: 'claude',
      waitForResolution: true,
      event: {
        hook_event_name: 'PermissionRequest',
        session_id: 'external-session-approval-auto',
        cwd: '/tmp/workspace-a',
        transcript_path: '/tmp/transcripts/external-session-approval-auto.jsonl',
        tool_name: 'Bash',
        tool_use_id: 'toolu-auto',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.resolution.behavior, 'allow');
    assert.equal(result.resolution.toolUseID, 'toolu-auto');
    assert.equal(result.thread.pendingApprovalCount, 0);
    assert.equal(service.listPendingApprovals('claude-thread-external-session-approval-auto').length, 0);
    assert.equal(
      service.getPendingAction('external-approval-external-session-approval-auto-toolu-auto')?.status,
      'auto-approved',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Elicitation hook creates a pending question for an external Claude session', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-question-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'Elicitation',
        session_id: 'external-session-question',
        cwd: '/tmp/workspace-a',
        transcript_path: '/tmp/transcripts/external-session-question.jsonl',
        prompt: 'Which plan should Claude use?',
        options: [
          { label: 'Plan A', description: 'Fast path' },
          { label: 'Plan B', description: 'Safe path' },
        ],
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.thread.pendingQuestionCount, 1);
    assert.equal(service.listPendingQuestions('claude-thread-external-session-question').length, 1);
    assert.equal(
      service.listPendingQuestions('claude-thread-external-session-question')[0].prompt,
      'Which plan should Claude use?',
    );
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'pending_question_requested' &&
          event.threadId === 'claude-thread-external-session-question' &&
          event.payload.question.prompt === 'Which plan should Claude use?',
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Stop and StopFailure hooks reconcile external Claude runtime state', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-stop-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'external-session-stop',
        cwd: '/tmp/workspace-a',
      },
      remoteAddress: '127.0.0.1',
    });

    const completed = await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'Stop',
        session_id: 'external-session-stop',
        cwd: '/tmp/workspace-a',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(completed.accepted, true);
    assert.equal(completed.thread.runtime.turnStatus, 'completed');
    assert.equal(completed.thread.runtime.source, 'claude-hook');
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'turn_completed' &&
          event.threadId === 'claude-thread-external-session-stop',
      ),
    );

    const failed = await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'StopFailure',
        session_id: 'external-session-failed',
        cwd: '/tmp/workspace-a',
        error: 'server_error',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(failed.accepted, true);
    assert.equal(failed.thread.id, 'claude-thread-external-session-failed');
    assert.equal(failed.thread.runtime.turnStatus, 'errored');
    assert.equal(failed.thread.runtime.source, 'claude-hook');
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'thread_status_changed' &&
          event.threadId === 'claude-thread-external-session-failed' &&
          event.payload.status.type === 'error',
      ),
    );

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persisted.threads['claude-thread-external-session-stop'], undefined);
    assert.equal(persisted.threads['claude-thread-external-session-failed'].turnStatus, 'errored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn rejects while an external Claude hook runtime is still active for the thread', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-active-hook-runtime-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponses: [[
      {
        type: 'system',
        subtype: 'init',
        session_id: 'external-session-running',
      },
      createSuccessResultMessage({
        sessionId: 'external-session-running',
        uuid: 'result-external-running',
        result: 'Should not start',
      }),
    ]],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: fakeClaudeSdk,
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    await service.setApprovalMode('manual');

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'external-session-running',
        cwd: '/tmp/workspace-a',
      },
      remoteAddress: '127.0.0.1',
    });

    await assert.rejects(
      service.startTurn('claude-thread-external-session-running', 'Take over this session'),
      /already running externally/i,
    );
    assert.equal(fakeClaudeSdk.calls.query.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('replayed PermissionRequest hooks keep resolved external approvals resolved', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-approval-replay-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    await service.setApprovalMode('manual');

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'PermissionRequest',
        session_id: 'external-session-approval-replay',
        cwd: '/tmp/workspace-a',
        tool_name: 'Bash',
        tool_use_id: 'toolu-replay',
      },
      remoteAddress: '127.0.0.1',
    });

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'PostToolUse',
        session_id: 'external-session-approval-replay',
        cwd: '/tmp/workspace-a',
        tool_use_id: 'toolu-replay',
      },
      remoteAddress: '127.0.0.1',
    });

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'PermissionRequest',
        session_id: 'external-session-approval-replay',
        cwd: '/tmp/workspace-a',
        tool_name: 'Bash',
        tool_use_id: 'toolu-replay',
      },
      remoteAddress: '127.0.0.1',
    });

    const action = service.getPendingAction('external-approval-external-session-approval-replay-toolu-replay');
    assert.equal(action?.status, 'approved');
    assert.equal(service.listPendingApprovals('claude-thread-external-session-approval-replay').length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('replayed Elicitation hooks keep answered external questions resolved', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-question-replay-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'Elicitation',
        session_id: 'external-session-question-replay',
        cwd: '/tmp/workspace-a',
        prompt: 'Choose a plan',
        tool_use_id: 'toolu-question',
        options: [{ label: 'A', description: 'Plan A' }],
      },
      remoteAddress: '127.0.0.1',
    });

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'ElicitationResult',
        session_id: 'external-session-question-replay',
        cwd: '/tmp/workspace-a',
        tool_use_id: 'toolu-question',
        response: 'A',
      },
      remoteAddress: '127.0.0.1',
    });

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'Elicitation',
        session_id: 'external-session-question-replay',
        cwd: '/tmp/workspace-a',
        prompt: 'Choose a plan',
        tool_use_id: 'toolu-question',
        options: [{ label: 'A', description: 'Plan A' }],
      },
      remoteAddress: '127.0.0.1',
    });

    const action = service.getPendingAction('external-question-external-session-question-replay-toolu-question');
    assert.equal(action?.status, 'answered');
    assert.equal(service.listPendingQuestions('claude-thread-external-session-question-replay').length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('replayed Stop hooks do not emit duplicate external turn_completed events', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-stop-replay-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'external-session-stop-replay',
        cwd: '/tmp/workspace-a',
      },
      remoteAddress: '127.0.0.1',
    });

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'Stop',
        session_id: 'external-session-stop-replay',
        cwd: '/tmp/workspace-a',
      },
      remoteAddress: '127.0.0.1',
    });

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'Stop',
        session_id: 'external-session-stop-replay',
        cwd: '/tmp/workspace-a',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(
      events.filter(
        (event) =>
          event.type === 'turn_completed' &&
          event.threadId === 'claude-thread-external-session-stop-replay',
      ).length,
      1,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('external Claude approvals can round-trip through a waiting relay request', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-hook-approval-bridge-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    await service.setApprovalMode('manual');

    const hookPromise = service.ingestExternalBridgeEvent({
      provider: 'claude',
      waitForResolution: true,
      event: {
        hook_event_name: 'PermissionRequest',
        session_id: 'external-session-bridge',
        cwd: '/tmp/workspace-a',
        tool_name: 'Bash',
        tool_use_id: 'toolu-bridge',
      },
      remoteAddress: '127.0.0.1',
    });

    await waitForCondition(
      () => service.listPendingApprovals('claude-thread-external-session-bridge').length === 1,
    );

    const approval = service.listPendingApprovals('claude-thread-external-session-bridge')[0];
    const resolved = await service.resolvePendingAction(approval.id, { decision: 'approved' });
    const hookResult = await hookPromise;

    assert.equal(resolved.status, 'approved');
    assert.equal(hookResult.accepted, true);
    assert.equal(hookResult.resolution.behavior, 'allow');
    assert.equal(hookResult.resolution.toolUseID, 'toolu-bridge');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('transcript watcher publishes best-effort task progress for a hooked external Claude session', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-transcript-watcher-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const transcriptPath = join(tempDir, 'external-session-tail.jsonl');
  await writeFile(transcriptPath, '', 'utf8');
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({
      filePath: runtimeStorePath,
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex: new ClaudeSdkSessionIndex({ filePath }),
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.ingestExternalBridgeEvent({
      provider: 'claude',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'external-session-tail',
        cwd: '/tmp/workspace-a',
        transcript_path: transcriptPath,
      },
      remoteAddress: '127.0.0.1',
    });

    await appendFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-tail-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-tail-1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Inspect transcript tail', status: 'completed' },
                  { content: 'Publish progress update', status: 'in_progress', activeForm: 'Publishing progress update' },
                ],
              },
            },
          ],
        },
      })}\n`,
      'utf8',
    );

    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'turn_plan_updated' &&
          event.threadId === 'claude-thread-external-session-tail',
      ),
    );

    const thread = (await service.readSession('claude-thread-external-session-tail')).thread;
    assert.equal(thread.external?.bridgeMode, 'hooked+tail');
    assert.equal(
      events.some(
        (event) =>
          event.type === 'turn_plan_updated' &&
          event.payload?.plan?.some((step) => step.step === 'Publishing progress update'),
      ),
      true,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude tool approvals pause the turn until a pending action is resolved', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-tool-approval-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  let approvalReleased = false;
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-approval',
          };
          const permission = await options.canUseTool(
            'Bash',
            { command: 'npm test', cwd: '/tmp/workspace-a' },
            {
              signal: options.abortController.signal,
              toolUseID: 'tool-use-approval-1',
              title: 'Run npm test',
            },
          );
          assert.equal(permission.behavior, 'allow');
          approvalReleased = true;
          yield createSuccessResultMessage({
            sessionId: 'claude-session-approval',
            uuid: 'result-1',
            result: 'Done',
          });
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.setApprovalMode('manual');
    await service.startTurn(created.thread.id, 'Run the tests');

    await waitForCondition(() => service.listPendingApprovals(created.thread.id).length === 1);
    await waitForCondition(() => events.some((event) => event.type === 'approval_requested'));

    const pendingApproval = service.listPendingApprovals(created.thread.id)[0];
    assert.equal(pendingApproval.summary, 'Run npm test');

    const resolved = await service.resolvePendingAction(pendingApproval.id, {
      decision: 'approved',
    });
    assert.equal(resolved.status, 'approved');

    await waitForCondition(() => approvalReleased === true);
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'approval_resolved' &&
          event.payload.approval.id === pendingApproval.id,
      ),
    );
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));

    const persistedRuntime = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persistedRuntime.pendingActions[pendingApproval.id].status, 'approved');
    assert.equal(fakeClaudeSdk.calls.queryStreamInput.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('handleAskUserQuestion persists a pending question that can be resolved later', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-pending-question-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    const pending = await service.handleAskUserQuestion({
      threadId: 'thread-cl-001',
      turnId: 'turn-123',
      prompt: 'Need permission to proceed?',
      questions: [
        {
          header: 'Plan',
          question: 'Need permission to proceed?',
          options: [
            { label: 'Plan A', description: 'Proceed with plan A' },
            { label: 'Plan B', description: 'Proceed with plan B' },
          ],
          multiSelect: false,
        },
      ],
    });

    assert.equal(pending.kind, 'ask_user_question');
    assert.equal(pending.prompt, 'Need permission to proceed?');
    assert.equal(service.listPendingQuestions('thread-cl-001').length, 1);
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'pending_question_requested' &&
          event.payload.question.id === pending.id,
      ),
    );

    const resolved = await service.resolvePendingAction(pending.id, {
      response: 'Proceed with plan A',
    });

    assert.equal(resolved.status, 'answered');
    assert.equal(service.getPendingAction(pending.id).status, 'answered');
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'pending_question_resolved' &&
          event.payload.question.id === pending.id,
      ),
    );

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persisted.pendingActions[pending.id].status, 'answered');
    assert.equal(persisted.pendingActions[pending.id].payload.response, 'Proceed with plan A');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readSession exposes pending questions in frontend-ready question shape', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-question-shape-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    await service.handleAskUserQuestion({
      threadId: created.thread.id,
      turnId: 'turn-123',
      prompt: 'Need permission to proceed?',
      questions: [
        {
          header: 'Plan',
          question: 'Need permission to proceed?',
          options: [
            { label: 'Plan A', description: 'Proceed with plan A' },
            { label: 'Plan B', description: 'Proceed with plan B' },
          ],
          multiSelect: false,
        },
      ],
    });

    const detail = await service.readSession(created.thread.id);

    assert.equal(detail.thread.pendingQuestionCount, 1);
    assert.equal(detail.thread.pendingQuestions[0].kind, 'ask_user_question');
    assert.equal(detail.thread.pendingQuestions[0].prompt, 'Need permission to proceed?');
    assert.deepEqual(detail.thread.pendingQuestions[0].questions, [
      {
        header: 'Plan',
        question: 'Need permission to proceed?',
        options: [
          { label: 'Plan A', description: 'Proceed with plan A', preview: null },
          { label: 'Plan B', description: 'Proceed with plan B', preview: null },
        ],
        multiSelect: false,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude ask-user-question tool pauses the turn and resumes through streamInput after resolution', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-ask-user-question-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const streamInputGate = createDeferred();
  let streamInputPayload = null;
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-question',
          };
          yield createAssistantToolUseMessage({
            uuid: 'assistant-1',
            toolUseId: 'tool-use-question-1',
            toolName: 'AskUserQuestion',
            input: {
              questions: [
                {
                  header: 'Plan',
                  question: 'Need permission to proceed?',
                  options: [
                    { label: 'Plan A', description: 'Proceed with plan A' },
                    { label: 'Plan B', description: 'Proceed with plan B' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          });
          await streamInputGate.promise;
          yield createSuccessResultMessage({
            sessionId: 'claude-session-question',
            uuid: 'result-1',
            result: 'Done',
          });
        },
        async streamInput(stream) {
          const messages = [];
          for await (const message of stream) {
            messages.push(message);
          }
          streamInputPayload = messages;
          streamInputGate.resolve();
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    await service.startTurn(created.thread.id, 'Need your input');

    await waitForCondition(() => service.listPendingQuestions(created.thread.id).length === 1, {
      timeoutMs: 2000,
    });
    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === 'session_runtime_reconciled' &&
            event.threadId === created.thread.id &&
            event.payload.runtime.turnStatus === 'started',
        ),
      { timeoutMs: 2000 },
    );

    const pendingQuestion = service.listPendingQuestions(created.thread.id)[0];
    assert.equal(pendingQuestion.prompt, 'Need permission to proceed?');

    const resolved = await service.resolvePendingAction(pendingQuestion.id, {
      response: 'Proceed with plan A',
    });
    assert.equal(resolved.status, 'answered');

    await waitForCondition(() => Array.isArray(streamInputPayload) && streamInputPayload.length === 1, {
      timeoutMs: 2000,
    });

    assert.equal(streamInputPayload[0].parent_tool_use_id, 'tool-use-question-1');
    assert.equal(streamInputPayload[0].session_id, 'claude-session-question');
    assert.deepEqual(streamInputPayload[0].tool_use_result.answers, {
      'Need permission to proceed?': 'Proceed with plan A',
    });
    assert.equal(fakeClaudeSdk.calls.queryStreamInput.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('interruptTurn releases pending ask-user-question waiters and clears the pending question', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-interrupt-question-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-question-interrupt',
          };
          yield createAssistantToolUseMessage({
            uuid: 'assistant-question-1',
            toolUseId: 'tool-use-question-interrupt-1',
            toolName: 'AskUserQuestion',
            input: {
              questions: [
                {
                  header: 'Plan',
                  question: 'Need permission to proceed?',
                  options: [
                    { label: 'Plan A', description: 'Proceed with plan A' },
                    { label: 'Plan B', description: 'Proceed with plan B' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          });
          await new Promise(() => {});
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    const started = await service.startTurn(created.thread.id, 'Need your input');

    await waitForCondition(() => service.listPendingQuestions(created.thread.id).length === 1, {
      timeoutMs: 2000,
    });

    await service.interruptTurn(created.thread.id, started.turnId);

    await waitForCondition(
      () =>
        events.some(
          (event) =>
            event.type === 'session_runtime_reconciled' &&
            event.payload.runtime.turnStatus === 'interrupted',
        ),
      { timeoutMs: 500 },
    );

    assert.equal(service.listPendingQuestions(created.thread.id).length, 0);

    const persisted = await runtimeStore.load();
    assert.equal(
      Object.values(persisted.pendingActions).filter(
        (action) =>
          action.threadId === created.thread.id &&
          action.kind === 'ask_user_question' &&
          action.status === 'pending',
      ).length,
      0,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn rejects duplicate active turns on the same Claude thread', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-duplicate-turn-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const gate = createDeferred();
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-duplicate',
          };
          await gate.promise;
          yield createSuccessResultMessage({
            sessionId: 'claude-session-duplicate',
            uuid: 'result-1',
            result: 'Done',
          });
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    const firstTurn = await service.startTurn(created.thread.id, 'First turn');

    await assert.rejects(
      service.startTurn(created.thread.id, 'Second turn'),
      /already running/i,
    );
    assert.equal(fakeClaudeSdk.calls.query.length, 1);

    gate.resolve();
    assert.match(firstTurn.turnId, /^turn-/);
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('interruptTurn aborts the live Claude query through the supplied AbortController', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-abort-fallback-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-abort',
          };
          await waitForAbort(options.abortController);
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));
    const started = await service.startTurn(created.thread.id, 'Hello Claude');

    await service.interruptTurn(created.thread.id, started.turnId);
    assert.equal(fakeClaudeSdk.calls.query[0].options.abortController.signal.aborted, true);
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'interrupted',
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude project listing augments the app index with discovered Claude sessions from known projects', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-listing-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    listSessionsResult: [
      {
        sessionId: 'rogue-session',
        summary: 'Raw SDK session',
        lastModified: 999,
      },
    ],
  });
  const activityStore = createMemoryActivityStore({
    projects: {
      '/tmp/workspace-a': {
        collapsed: true,
        focusedThreadIds: ['thread-focused'],
        hidden: false,
      },
    },
  });
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'thread-focused',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Focused Claude thread',
      updatedAt: 10,
    });
    await sessionIndex.upsertThread({
      threadId: 'thread-history',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-2',
      summary: 'Historical Claude thread',
      updatedAt: 5,
    });

    const result = await service.listProjects();

    assert.deepEqual(fakeClaudeSdk.calls.listSessions, [
      {
        dir: '/tmp/workspace-a',
      },
    ]);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].id, '/tmp/workspace-a');
    assert.equal(result.projects[0].collapsed, true);
    assert.deepEqual(
      result.projects[0].focusedSessions.map((thread) => thread.id),
      ['thread-focused'],
    );
    assert.equal(result.projects[0].focusedSessions[0].external, undefined);
    assert.deepEqual(
      result.projects[0].historySessions.active.map((thread) => thread.id),
      ['claude-thread-rogue-session', 'thread-history'],
    );
    assert.equal(result.projects[0].historySessions.active[0].name, 'Raw SDK session');
    assert.deepEqual(result.projects[0].historySessions.active[0].external, {
      bridgeMode: 'discovered',
      runtimeSource: 'claude-discovered',
      lastSeenAt: result.projects[0].historySessions.active[0].external.lastSeenAt,
    });
    assert.equal(result.projects[0].historySessions.active[0].external.lastSeenAt > 0, true);
    assert.equal(
      (await sessionIndex.readThread('claude-thread-rogue-session'))?.claudeSessionId,
      'rogue-session',
    );
    assert.equal(
      (await sessionIndex.readThread('claude-thread-rogue-session'))?.bridgeMode,
      'discovered',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude project listing reconciles imported duplicates once the same sdk session is app-owned', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-dedup-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createMemoryActivityStore({
    projects: {
      '/tmp/workspace-a': {
        collapsed: false,
        focusedThreadIds: ['thread-app-owned'],
        hidden: false,
      },
    },
  });
  const fakeClaudeSdk = createFakeClaudeSdk({
    listSessionsResult: [
      {
        sessionId: 'shared-session',
        summary: 'Shared Claude session',
        lastModified: 999,
      },
    ],
  });
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    runtimeStore: new RuntimeStore({
      filePath: join(tempDir, 'claude-runtime-store.json'),
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'claude-thread-shared-session',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'Imported duplicate',
      bridgeMode: 'discovered',
      updatedAt: 900,
    });
    await sessionIndex.upsertThread({
      threadId: 'thread-app-owned',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'App-owned Claude session',
      updatedAt: 950,
    });

    const result = await service.listProjects();

    assert.deepEqual(
      result.projects[0].focusedSessions.map((thread) => thread.id),
      ['thread-app-owned'],
    );
    assert.deepEqual(result.projects[0].historySessions.active, []);
    assert.equal(await sessionIndex.readThread('claude-thread-shared-session'), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(
  'Claude project listing refreshes updatedAt on repeat discovery when sdk sessions omit lastModified',
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-listing-missing-last-modified-'));
    const filePath = join(tempDir, 'claude-session-index.json');
    const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
    const fakeClaudeSdk = createFakeClaudeSdk({
      listSessionsResult: [
        {
          sessionId: 'rogue-session-no-time',
          summary: 'Raw SDK session without timestamp',
        },
      ],
    });
    const service = new ClaudeSdkSessionService({
      activityStore: createMemoryActivityStore({
        projects: {
          '/tmp/workspace-a': {
            collapsed: false,
            focusedThreadIds: [],
            hidden: false,
          },
        },
      }),
      claudeSdk: fakeClaudeSdk,
      runtimeStore: new RuntimeStore({
        filePath: join(tempDir, 'claude-runtime-store.json'),
      }),
      cwd: '/tmp/default-cwd',
      sessionIndex,
    });

    try {
      const first = await service.listProjects();
      const imported = first.projects[0].historySessions.active[0];

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const second = await service.listProjects();
      const importedAgain = second.projects[0].historySessions.active[0];

      assert.equal(imported.updatedAt > 0, true);
      assert.equal(imported.createdAt > 0, true);
      assert.equal(importedAgain.updatedAt > imported.updatedAt, true);
      assert.equal(importedAgain.external.lastSeenAt > imported.external.lastSeenAt, true);
      assert.equal(
        (await sessionIndex.readThread('claude-thread-rogue-session-no-time'))?.updatedAt > 0,
        true,
      );
      assert.equal(
        (await sessionIndex.readThread('claude-thread-rogue-session-no-time'))?.createdAt > 0,
        true,
      );
      assert.equal(
        (await sessionIndex.readThread('claude-thread-rogue-session-no-time'))?.updatedAt,
        importedAgain.updatedAt,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test('Claude project listing keeps indexed sessions when sdk discovery throws', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-listing-discovery-failure-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createMemoryActivityStore({
    projects: {
      '/tmp/workspace-a': {
        collapsed: false,
        focusedThreadIds: ['thread-focused'],
        hidden: false,
      },
    },
  });
  const baseSdk = createFakeClaudeSdk();
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: {
      ...baseSdk,
      async listSessions(options = {}) {
        baseSdk.calls.listSessions.push(options);
        throw new Error('Claude discovery failed');
      },
    },
    runtimeStore: new RuntimeStore({
      filePath: join(tempDir, 'claude-runtime-store.json'),
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'thread-focused',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Focused Claude thread',
      updatedAt: 10,
    });

    const result = await service.listProjects();

    assert.deepEqual(result.projects[0].focusedSessions.map((thread) => thread.id), ['thread-focused']);
    assert.equal(result.projects[0].historySessions.active.length, 0);
    assert.deepEqual(baseSdk.calls.listSessions, [{ dir: '/tmp/workspace-a' }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude project listing migrates focused imported duplicates onto the surviving app-owned thread', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-dedup-focused-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createMemoryActivityStore({
    projects: {
      '/tmp/workspace-a': {
        collapsed: false,
        focusedThreadIds: ['claude-thread-shared-session'],
        hidden: false,
      },
    },
  });
  const fakeClaudeSdk = createFakeClaudeSdk({
    listSessionsResult: [
      {
        sessionId: 'shared-session',
        summary: 'Shared Claude session',
        lastModified: 999,
      },
    ],
  });
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    runtimeStore: new RuntimeStore({
      filePath: join(tempDir, 'claude-runtime-store.json'),
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'claude-thread-shared-session',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'Imported duplicate',
      bridgeMode: 'discovered',
      updatedAt: 900,
    });
    await sessionIndex.upsertThread({
      threadId: 'thread-app-owned',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'App-owned Claude session',
      updatedAt: 950,
    });

    const result = await service.listProjects();

    assert.deepEqual(
      result.projects[0].focusedSessions.map((thread) => thread.id),
      ['thread-app-owned'],
    );
    assert.equal(result.projects[0].focusedSessions[0].name, 'Shared Claude session');
    assert.equal(result.projects[0].historySessions.active.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude project listing reloads activity after duplicate migration when the store returns snapshots', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-dedup-snapshots-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createSnapshottingActivityStore({
    projects: {
      '/tmp/workspace-a': {
        collapsed: false,
        focusedThreadIds: ['claude-thread-shared-session'],
        hidden: false,
      },
    },
  });
  const fakeClaudeSdk = createFakeClaudeSdk({
    listSessionsResult: [
      {
        sessionId: 'shared-session',
        summary: 'Shared Claude session',
        lastModified: 999,
      },
    ],
  });
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    runtimeStore: new RuntimeStore({
      filePath: join(tempDir, 'claude-runtime-store.json'),
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'claude-thread-shared-session',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'Imported duplicate',
      bridgeMode: 'discovered',
      updatedAt: 900,
    });
    await sessionIndex.upsertThread({
      threadId: 'thread-app-owned',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'App-owned Claude session',
      updatedAt: 950,
    });

    const result = await service.listProjects();

    assert.deepEqual(
      result.projects[0].focusedSessions.map((thread) => thread.id),
      ['thread-app-owned'],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude project listing migrates runtime state from a deduped imported thread to the surviving app-owned thread', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-dedup-runtime-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createMemoryActivityStore({
    projects: {
      '/tmp/workspace-a': {
        collapsed: false,
        focusedThreadIds: ['claude-thread-shared-session'],
        hidden: false,
      },
    },
  });
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const fakeClaudeSdk = createFakeClaudeSdk({
    listSessionsResult: [
      {
        sessionId: 'shared-session',
        summary: 'Shared Claude session',
        lastModified: 999,
      },
    ],
  });
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'claude-thread-shared-session',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'Imported duplicate',
      bridgeMode: 'discovered',
      updatedAt: 900,
    });
    await sessionIndex.upsertThread({
      threadId: 'thread-app-owned',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'shared-session',
      summary: 'App-owned Claude session',
      updatedAt: 950,
    });
    await service.ensureRuntimeStoreLoaded();
    service.setRuntime('claude-thread-shared-session', {
      turnStatus: 'started',
      activeTurnId: 'turn-123',
      diff: null,
      realtime: null,
    });
    await service.persistRuntimeSnapshot('claude-thread-shared-session');

    const result = await service.listProjects();

    assert.equal(result.projects[0].focusedSessions[0].runtime.turnStatus, 'started');
    assert.equal(service.runtimeByThread.has('claude-thread-shared-session'), false);
    assert.equal(service.runtimeByThread.get('thread-app-owned')?.turnStatus, 'started');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Claude project listing prunes stale discovered external sessions that disappear from sdk discovery', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-project-prune-stale-discovered-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  let discoveryRound = 0;
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: {
      ...createFakeClaudeSdk(),
      async listSessions() {
        discoveryRound += 1;
        return discoveryRound === 1
          ? [
              {
                sessionId: 'rogue-session',
                summary: 'Raw SDK session',
                lastModified: 999,
              },
            ]
          : [];
      },
    },
    runtimeStore: new RuntimeStore({
      filePath: join(tempDir, 'claude-runtime-store.json'),
    }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const first = await service.listProjects();
    assert.deepEqual(
      first.projects[0].historySessions.active.map((thread) => thread.id),
      ['claude-thread-rogue-session'],
    );

    const second = await service.listProjects();

    assert.deepEqual(second.projects[0].historySessions.active, []);
    assert.equal(await sessionIndex.readThread('claude-thread-rogue-session'), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readSession rebuilds the browser thread shape from stored Claude transcript data', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-read-session-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    sessionInfoById: {
      'claude-session-1': {
        sessionId: 'claude-session-1',
        summary: 'Fix the tests',
        cwd: '/tmp/workspace-a',
        createdAt: 1_700_000_000_000,
        lastModified: 1_700_000_100_000,
      },
    },
    sessionMessagesById: {
      'claude-session-1': [
        {
          type: 'user',
          uuid: 'msg-user-1',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Fix the tests' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-assistant-1',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will run the test suite.' },
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'Bash',
                input: {
                  command: 'npm test',
                  cwd: '/tmp/workspace-a',
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'msg-tool-result-1',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-1',
                content: '1 passing',
                is_error: false,
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-assistant-2',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The suite is green.' }],
          },
        },
      ],
    },
  });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    sessionIndex,
  });

  try {
    await sessionIndex.upsertThread({
      threadId: 'thread-1',
      projectId: '/tmp/workspace-a',
      claudeSessionId: 'claude-session-1',
      summary: 'Fix the tests',
      updatedAt: 10,
    });

    const result = await service.readSession('thread-1');

    assert.equal(result.thread.id, 'thread-1');
    assert.equal(result.thread.cwd, '/tmp/workspace-a');
    assert.equal(result.thread.name, 'Fix the tests');
    assert.equal(result.thread.preview, 'Fix the tests');
    assert.equal(result.thread.turns.length, 1);
    assert.equal(result.thread.turns[0].status, 'completed');
    assert.deepEqual(
      result.thread.turns[0].items.map((item) => item.type),
      ['userMessage', 'agentMessage', 'commandExecution', 'agentMessage'],
    );
    assert.equal(result.thread.turns[0].items[0].content[0].text, 'Fix the tests');
    assert.equal(result.thread.turns[0].items[1].text, 'I will run the test suite.');
    assert.equal(result.thread.turns[0].items[1].phase, 'commentary');
    assert.equal(result.thread.turns[0].items[2].command, 'npm test');
    assert.equal(result.thread.turns[0].items[2].aggregatedOutput, '1 passing');
    assert.equal(result.thread.turns[0].items[3].text, 'The suite is green.');
    assert.equal(result.thread.turns[0].items[3].phase, 'final_answer');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startTurn streams normalized Claude events and task updates while returning an active turn id', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-streaming-turn-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-stream',
            uuid: 'init-1',
          };
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: 'Analyzing the failing tests',
              },
            },
            parent_tool_use_id: null,
            uuid: 'partial-1',
            session_id: 'claude-session-stream',
          };
          yield {
            type: 'assistant',
            uuid: 'assistant-1',
            session_id: 'claude-session-stream',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Analyzing the failing tests' },
                {
                  type: 'tool_use',
                  id: 'toolu-1',
                  name: 'Bash',
                  input: {
                    command: 'npm test',
                    cwd: '/tmp/workspace-a',
                  },
                },
              ],
            },
          };
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task-1',
            description: 'Run tests',
            uuid: 'task-start-1',
            session_id: 'claude-session-stream',
          };
          yield {
            type: 'tool_progress',
            tool_use_id: 'toolu-1',
            tool_name: 'Bash',
            parent_tool_use_id: null,
            elapsed_time_seconds: 1,
            task_id: 'task-1',
            uuid: 'tool-progress-1',
            session_id: 'claude-session-stream',
          };
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-1',
            status: 'completed',
            output_file: '/tmp/task-1.txt',
            summary: 'Run tests',
            uuid: 'task-done-1',
            session_id: 'claude-session-stream',
          };
          yield {
            type: 'user',
            uuid: 'tool-result-1',
            session_id: 'claude-session-stream',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu-1',
                  content: '1 passing',
                  is_error: false,
                },
              ],
            },
          };
          yield {
            type: 'assistant',
            uuid: 'assistant-2',
            session_id: 'claude-session-stream',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'The suite is green.' }],
            },
          };
          yield createSuccessResultMessage({
            sessionId: 'claude-session-stream',
            uuid: 'result-1',
            result: 'The suite is green.',
          });
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await service.startTurn(created.thread.id, 'Hello Claude');
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));

    assert.match(result.turnId, /^turn-/);
    assert.equal(result.status, 'started');
    assert.equal(events[0].type, 'turn_started');
    assert.equal(events[0].payload.turnId, result.turnId);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'thread_item_delta' &&
          event.payload.itemType === 'agentMessage',
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) => event.type === 'thread_item_started' && event.payload.item.type === 'commandExecution',
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) => event.type === 'thread_item_completed' && event.payload.item.type === 'commandExecution',
      ),
      true,
    );

    const lastPlanUpdate = events.filter((event) => event.type === 'turn_plan_updated').at(-1);
    assert.deepEqual(lastPlanUpdate?.payload.plan, [
      {
        step: 'Run tests',
        status: 'completed',
      },
    ]);

    const persistedThreads = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persistedThreads.threads[created.thread.id].claudeSessionId, 'claude-session-stream');
    assert.deepEqual((await runtimeStore.load()).threads, {});
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('TodoWrite tool updates are normalized into sidebar task plan events', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-todo-stream-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStore = new RuntimeStore({
    filePath: join(tempDir, 'claude-runtime-store.json'),
  });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-todos',
            uuid: 'init-1',
          };
          yield {
            type: 'assistant',
            uuid: 'assistant-todos-1',
            session_id: 'claude-session-todos',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu-todos-1',
                  name: 'TodoWrite',
                  input: {
                    todos: [
                      {
                        content: 'Audit the session lifecycle',
                        status: 'completed',
                        activeForm: 'Auditing the session lifecycle',
                      },
                      {
                        content: 'Reconnect interrupted runs',
                        status: 'in_progress',
                        activeForm: 'Reconnecting interrupted runs',
                      },
                      {
                        content: 'Verify the regression tests',
                        status: 'pending',
                        activeForm: 'Verifying the regression tests',
                      },
                    ],
                  },
                },
              ],
            },
          };
          yield createSuccessResultMessage({
            sessionId: 'claude-session-todos',
            uuid: 'result-1',
            result: 'Done',
          });
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.startTurn(created.thread.id, 'Track the work');
    await waitForCondition(() => events.some((event) => event.type === 'turn_completed'));

    const planUpdate = events.find((event) => event.type === 'turn_plan_updated');
    assert.deepEqual(planUpdate?.payload.plan, [
      { step: 'Audit the session lifecycle', status: 'completed' },
      { step: 'Reconnecting interrupted runs', status: 'inProgress' },
      { step: 'Verify the regression tests', status: 'pending' },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('interruptTurn aborts the active Claude stream and reconciles runtime as interrupted', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-interrupt-turn-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      ({ options }) => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-interrupt',
            uuid: 'init-1',
          };
          await waitForAbort(options.abortController);
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createMemoryActivityStore();
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    const started = await service.startTurn(created.thread.id, 'Hello Claude');
    const interruptResult = await service.interruptTurn(created.thread.id, started.turnId);

    assert.equal(interruptResult.thread.runtime.turnStatus, 'interrupting');
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'interrupted',
      ),
    );

    assert.equal(
      events.some(
        (event) =>
          event.type === 'thread_status_changed' &&
          event.payload.status?.type === 'idle',
      ),
      true,
    );

    const persistedRuntime = await runtimeStore.load();
    assert.equal(persistedRuntime.threads[created.thread.id].turnStatus, 'interrupted');
    assert.equal(persistedRuntime.threads[created.thread.id].activeTurnId, null);

    const reloadedService = new ClaudeSdkSessionService({
      activityStore,
      claudeSdk: createFakeClaudeSdk(),
      runtimeStore: new RuntimeStore({ filePath: runtimeStorePath }),
      cwd: '/tmp/default-cwd',
      sessionIndex,
    });
    const detail = await reloadedService.readSession(created.thread.id);

    assert.equal(detail.thread.runtime.turnStatus, 'interrupted');
    assert.equal(detail.thread.runtime.realtime.lastError.includes('interrupted'), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('failed Claude turns reconcile runtime as errored and keep the snapshot for recovery', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-failed-turn-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'claude-session-error',
            uuid: 'init-1',
          };
          yield createErrorResultMessage({
            sessionId: 'claude-session-error',
            uuid: 'result-err-1',
            errors: ['Tool execution failed'],
          });
        },
      }),
    ],
  });
  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  const activityStore = createMemoryActivityStore();
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: fakeClaudeSdk,
    runtimeStore,
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const created = await service.createSessionInProject('/tmp/workspace-a');
    const events = [];
    service.subscribe((event) => events.push(event));

    const started = await service.startTurn(created.thread.id, 'Hello Claude');
    assert.match(started.turnId, /^turn-/);

    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.runtime.turnStatus === 'errored',
      ),
    );

    assert.equal(events.some((event) => event.type === 'turn_completed'), false);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'thread_status_changed' &&
          event.payload.status?.type === 'error',
      ),
      true,
    );

    const persistedRuntime = await runtimeStore.load();
    assert.equal(persistedRuntime.threads[created.thread.id].turnStatus, 'errored');
    assert.equal(
      persistedRuntime.threads[created.thread.id].realtime.lastError,
      'Tool execution failed',
    );

    const reloadedService = new ClaudeSdkSessionService({
      activityStore,
      claudeSdk: createFakeClaudeSdk(),
      runtimeStore: new RuntimeStore({ filePath: runtimeStorePath }),
      cwd: '/tmp/default-cwd',
      sessionIndex,
    });
    const detail = await reloadedService.readSession(created.thread.id);

    assert.equal(detail.thread.runtime.turnStatus, 'errored');
    assert.equal(detail.thread.runtime.realtime.lastError, 'Tool execution failed');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('markActiveSessionsInterrupted converts persisted Claude runtime snapshots to interrupted on restart', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-runtime-reconcile-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const threadId = 'thread-cl-reconcile-1';
  await runtimeStore.setThreadRuntime(threadId, {
    turnStatus: 'started',
    activeTurnId: 'turn-running-1',
    realtime: {
      status: 'started',
      sessionId: 'claude-session-reconcile',
      items: [],
      audioChunkCount: 0,
      audioByteCount: 0,
      lastAudio: null,
      lastError: null,
      closeReason: null,
    },
  });

  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  await sessionIndex.upsertThread({
    threadId,
    projectId: '/tmp/workspace-a',
    claudeSessionId: 'claude-session-reconcile',
    summary: 'Interrupted by restart',
    updatedAt: 10,
  });

  const activityStore = createMemoryActivityStore();
  const service = new ClaudeSdkSessionService({
    activityStore,
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({ filePath: runtimeStorePath }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await service.markActiveSessionsInterrupted('claude-sdk backend restarted');

    assert.deepEqual(result, {
      ok: true,
      threadIds: [threadId],
    });
    assert.equal(
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.threadId === threadId &&
          event.payload.runtime.turnStatus === 'interrupted',
      ),
      true,
    );

    const detail = await service.readSession(threadId);
    assert.equal(detail.thread.runtime.turnStatus, 'interrupted');
    assert.match(detail.thread.runtime.realtime.lastError, /backend restarted/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('markActiveSessionsInterrupted preserves active claude-hook runtime snapshots until a new hook arrives', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-runtime-hook-reconcile-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const threadId = 'claude-thread-external-running';
  await runtimeStore.setThreadRuntime(threadId, {
    turnStatus: 'started',
    activeTurnId: 'external-turn-session-hook',
    source: 'claude-hook',
    realtime: {
      status: 'started',
      sessionId: 'external-session-hook',
      items: [],
      audioChunkCount: 0,
      audioByteCount: 0,
      lastAudio: null,
      lastError: null,
      closeReason: null,
    },
  });

  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  await sessionIndex.upsertThread({
    threadId,
    projectId: '/tmp/workspace-a',
    claudeSessionId: 'external-session-hook',
    summary: 'External Claude session',
    bridgeMode: 'hooked',
    updatedAt: 10,
  });

  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore({
      projects: {
        '/tmp/workspace-a': {
          collapsed: false,
          focusedThreadIds: [],
          hidden: false,
        },
      },
    }),
    claudeSdk: createFakeClaudeSdk(),
    runtimeStore: new RuntimeStore({ filePath: runtimeStorePath }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await service.markActiveSessionsInterrupted('claude-sdk backend restarted');

    assert.deepEqual(result, {
      ok: true,
      threadIds: [],
    });
    assert.equal(
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.threadId === threadId,
      ),
      false,
    );
    assert.equal(service.runtimeByThread.get(threadId)?.turnStatus, 'started');
    assert.equal(service.runtimeByThread.get(threadId)?.source, 'claude-hook');

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persisted.threads[threadId].turnStatus, 'started');
    assert.equal(persisted.threads[threadId].source, 'claude-hook');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('markActiveSessionsInterrupted clears active runtime snapshots when Claude transcript already finished the turn', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-runtime-completed-reconcile-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const threadId = 'thread-cl-reconcile-completed';
  const sessionId = 'claude-session-completed';
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  await runtimeStore.setThreadRuntime(threadId, {
    turnStatus: 'started',
    activeTurnId: 'turn-running-2',
    realtime: {
      status: 'started',
      sessionId,
      items: [],
      audioChunkCount: 0,
      audioByteCount: 0,
      lastAudio: null,
      lastError: null,
      closeReason: null,
    },
  });

  const sessionIndex = new ClaudeSdkSessionIndex({ filePath });
  await sessionIndex.upsertThread({
    threadId,
    projectId: '/tmp/workspace-a',
    claudeSessionId: sessionId,
    summary: 'Completed while reconnecting',
    updatedAt: 100,
  });

  const service = new ClaudeSdkSessionService({
    activityStore: createMemoryActivityStore(),
    claudeSdk: createFakeClaudeSdk({
      sessionInfoById: {
        [sessionId]: {
          sessionId,
          summary: 'Completed while reconnecting',
          cwd: '/tmp/workspace-a',
          createdAt: 100_000,
          lastModified: 200_000,
        },
      },
      sessionMessagesById: {
        [sessionId]: [
          {
            type: 'user',
            uuid: 'msg-user-1',
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Continue the work' }],
            },
          },
          {
            type: 'assistant',
            uuid: 'msg-assistant-1',
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Finished.' }],
            },
          },
          createSuccessResultMessage({
            sessionId,
            uuid: 'result-1',
            result: 'Finished.',
          }),
        ],
      },
    }),
    runtimeStore: new RuntimeStore({ filePath: runtimeStorePath }),
    cwd: '/tmp/default-cwd',
    sessionIndex,
  });

  try {
    const events = [];
    service.subscribe((event) => events.push(event));

    const result = await service.markActiveSessionsInterrupted('claude-sdk backend restarted');

    assert.deepEqual(result, {
      ok: true,
      threadIds: [],
    });
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === 'session_runtime_reconciled' &&
          event.payload.threadId === threadId &&
          event.payload.runtime.turnStatus === 'idle',
      ),
    );

    const persistedRuntime = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.equal(persistedRuntime.threads[threadId], undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createMemoryActivityStore(initialSnapshot = { projects: {} }) {
  const snapshot = {
    projects: structuredClone(initialSnapshot.projects ?? {}),
  };

  return {
    async load() {
      return snapshot;
    },
    async addProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = false;
      return snapshot.projects[projectId];
    },
    async addFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      if (!snapshot.projects[projectId].focusedThreadIds.includes(threadId)) {
        snapshot.projects[projectId].focusedThreadIds.push(threadId);
      }
      snapshot.projects[projectId].hidden = false;
      return snapshot.projects[projectId];
    },
    async removeFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].focusedThreadIds = snapshot.projects[projectId].focusedThreadIds.filter(
        (candidate) => candidate !== threadId,
      );
      return snapshot.projects[projectId];
    },
    async setCollapsed(projectId, collapsed) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].collapsed = Boolean(collapsed);
      return snapshot.projects[projectId];
    },
    async hideProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = true;
      snapshot.projects[projectId].focusedThreadIds = [];
      return snapshot.projects[projectId];
    },
  };
}

function createSnapshottingActivityStore(initialSnapshot = { projects: {} }) {
  let snapshot = {
    projects: structuredClone(initialSnapshot.projects ?? {}),
  };

  return {
    async load() {
      return structuredClone(snapshot);
    },
    async addProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        hidden: false,
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async addFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      const focusedThreadIds = snapshot.projects[projectId].focusedThreadIds.includes(threadId)
        ? snapshot.projects[projectId].focusedThreadIds
        : [...snapshot.projects[projectId].focusedThreadIds, threadId];
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        focusedThreadIds,
        hidden: false,
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async removeFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        focusedThreadIds: snapshot.projects[projectId].focusedThreadIds.filter(
          (candidate) => candidate !== threadId,
        ),
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async setCollapsed(projectId, collapsed) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        collapsed: Boolean(collapsed),
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async hideProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        hidden: true,
        focusedThreadIds: [],
      };
      return structuredClone(snapshot.projects[projectId]);
    },
  };
}

function createSuccessResultMessage({ sessionId, uuid, result }) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: sessionId,
  };
}

function createErrorResultMessage({ sessionId, uuid, errors }) {
  return {
    ...createSuccessResultMessage({
      sessionId,
      uuid,
      result: null,
    }),
    is_error: true,
    subtype: 'error',
    errors,
  };
}

function createAssistantToolUseMessage({ uuid, toolUseId, toolName, input }) {
  return {
    type: 'assistant',
    uuid,
    message: {
      id: uuid,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input,
        },
      ],
    },
  };
}

async function readFirstPromptMessage(prompt) {
  const iterator = prompt?.[Symbol.asyncIterator]?.();
  if (!iterator || typeof iterator.next !== 'function') {
    throw new Error('prompt is not an async iterable');
  }

  const first = await iterator.next();
  if (!first || first.done) {
    throw new Error('prompt async iterable yielded no messages');
  }

  return first.value;
}

async function waitForCondition(predicate, { timeoutMs = 500 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('condition was not met before the timeout elapsed');
}

async function waitForAbort(abortController) {
  if (!abortController) {
    await new Promise(() => {});
    return;
  }

  if (abortController.signal.aborted) {
    throw createAbortError();
  }

  await new Promise((resolve, reject) => {
    abortController.signal.addEventListener(
      'abort',
      () => reject(createAbortError()),
      { once: true },
    );
  });
}

function createAbortError() {
  const error = new Error('Query aborted');
  error.name = 'AbortError';
  return error;
}

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}
