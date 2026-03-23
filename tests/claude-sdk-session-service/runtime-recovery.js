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

