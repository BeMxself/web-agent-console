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

