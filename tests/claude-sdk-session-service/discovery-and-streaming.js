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

