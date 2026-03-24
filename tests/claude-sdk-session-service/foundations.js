import {
  test,
  assert,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  tmpdir,
  join,
  ClaudeSdkSessionIndex,
  ClaudeSdkSessionService,
  SessionService,
  RuntimeStore,
  createFakeClaudeSdk,
  createMemoryActivityStore,
  createSnapshottingActivityStore,
  createSuccessResultMessage,
  createErrorResultMessage,
  createAssistantToolUseMessage,
  readFirstPromptMessage,
  waitForCondition,
  waitForAbort,
  createDeferred,
} from '../helpers/claude-sdk-session-service-test-helpers.js';

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
    new URL('../../src/lib/claude-sdk-session-service.js', import.meta.url),
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
        type: 'image',
        url: 'data:image/png;base64,Zm9v',
        mimeType: 'image/png',
        name: null,
      },
      {
        type: 'attachmentSummary',
        attachmentType: 'pdf',
        mimeType: 'application/pdf',
        name: 'report.pdf',
        dataBase64: 'YmFy',
      },
      {
        type: 'attachmentSummary',
        attachmentType: 'text',
        mimeType: 'text/plain',
        name: 'notes.txt',
        textContent: 'hello',
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
