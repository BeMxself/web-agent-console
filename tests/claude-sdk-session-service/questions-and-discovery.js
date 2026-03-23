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

