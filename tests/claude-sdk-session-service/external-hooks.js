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

test('Claude session service exposes session options and persists per-session settings', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-session-service-settings-'));
  const filePath = join(tempDir, 'claude-session-index.json');
  const runtimeStorePath = join(tempDir, 'claude-runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath: runtimeStorePath });
  const fakeClaudeSdk = createFakeClaudeSdk({
    queryResponseFactories: [
      () => ({
        async supportedAgents() {
          return [
            { name: 'Explore', description: 'Explore the codebase' },
            { name: 'Plan', description: 'Plan implementation' },
          ];
        },
        async close() {},
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
      agentTypeOptions: [
        { value: 'Explore', label: 'Explore' },
        { value: 'Plan', label: 'Plan' },
      ],
      rewriteCapabilities: {
        branch: true,
        inPlace: true,
      },
      defaults: {
        model: null,
        reasoningEffort: null,
        agentType: null,
      },
    });
    assert.deepEqual(await service.getSessionSettings('thread-cl-001'), {
      model: null,
      reasoningEffort: null,
      agentType: null,
    });

    assert.deepEqual(
      await service.setSessionSettings('thread-cl-001', {
        model: 'sonnet',
        reasoningEffort: 'high',
        agentType: 'Plan',
      }),
      {
        model: 'sonnet',
        reasoningEffort: 'high',
        agentType: 'Plan',
      },
    );

    const persisted = await new RuntimeStore({ filePath: runtimeStorePath }).load();
    assert.deepEqual(persisted.threadSettings['thread-cl-001'], {
      model: 'sonnet',
      reasoningEffort: 'high',
      agentType: 'Plan',
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
      agentType: 'Plan',
    });

    assert.deepEqual(
      await service.setSessionSettings('thread-cl-001', {
        model: null,
        reasoningEffort: null,
        agentType: null,
      }),
      {
        model: null,
        reasoningEffort: null,
        agentType: null,
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
