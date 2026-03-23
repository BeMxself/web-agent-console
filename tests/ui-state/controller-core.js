import {
  test,
  assert,
  createAppController,
  createFakeDocument,
  createFakeEventSource,
  createFakeStorage,
  createDeferred,
  createFakeFile,
  createClipboardImageItem,
  assertTaskSummaryItem,
  assertComposerSetting,
  jsonResponse,
  jsonErrorResponse,
} from './shared.js';

test('browser app posts pending question responses through the pending-action route', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: 'Question thread' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Question thread',
            cwd: '/tmp/workspace-a',
            pendingQuestionCount: 1,
            pendingQuestions: [
              {
                id: 'question-1',
                threadId: 'thread-1',
                kind: 'ask_user_question',
                summary: '需要用户回答',
                prompt: '请选择下一步',
                questions: [{ question: '继续执行吗？' }],
                status: 'pending',
              },
            ],
            turns: [],
          },
        });
      }

      if (url === '/api/auth/session') {
        return jsonResponse({ authenticated: true, required: false });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          requests: { status: 'idle' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      if (url === '/api/pending-actions/question-1/respond') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({
          id: 'question-1',
          status: 'answered',
          payload: { response: 'yes, continue' },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.selectSession('thread-1');
  assert.match(fakeDocument.conversationBody.innerHTML, /需要用户回答/);
  assert.match(fakeDocument.conversationBody.innerHTML, /data-pending-action-submit="question-1"/);

  await app.resolvePendingAction('question-1', { response: 'yes, continue' });
  assert.deepEqual(requests, [
    {
      url: '/api/pending-actions/question-1/respond',
      method: 'POST',
      body: { response: 'yes, continue' },
    },
  ]);
});

test('browser app resets session history scroll, uses a history dialog, posts turns, interrupts turns, and applies incoming sse events', async () => {
  const requests = [];
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage();
  let sessionsResponseCount = 0;
  let collapsedState = false;
  let extraProjectAdded = false;
  let createdProjectSession = false;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        sessionsResponseCount += 1;
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: collapsedState,
              focusedSessions:
                sessionsResponseCount > 2 || createdProjectSession
                  ? [
                      { id: 'thread-1', name: 'Focus thread' },
                      { id: 'thread-3', name: 'Project session' },
                      { id: 'thread-2', name: 'Imported thread' },
                    ]
                  : sessionsResponseCount > 1
                    ? [
                        { id: 'thread-1', name: 'Focus thread' },
                        { id: 'thread-2', name: 'Imported thread' },
                      ]
                    : [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: {
                active: sessionsResponseCount > 1 ? [] : [{ id: 'thread-2', name: 'Imported thread' }],
                archived: [],
              },
            },
            ...(extraProjectAdded
              ? [
                  {
                    id: '/tmp/workspace-b',
                    cwd: '/tmp/workspace-b',
                    displayName: 'workspace-b',
                    collapsed: false,
                    focusedSessions: [],
                    historySessions: {
                      active: [],
                      archived: [],
                    },
                  },
                ]
              : []),
          ],
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Hello session',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/sessions/thread-3') {
        return jsonResponse({
          thread: {
            id: 'thread-3',
            name: 'Project session',
            cwd: '/tmp/workspace-a',
            turns: [
              { id: 'turn-1', status: 'completed', items: [] },
              { id: 'turn-2', status: 'completed', items: [] },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-1/turns') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ turnId: 'turn-2', status: 'started' }, 202);
      }

      if (url === '/api/sessions/thread-1/interrupt') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ interrupted: true }, 202);
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-a/focused-sessions') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ ok: true });
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-a/collapse') {
        collapsedState = JSON.parse(options.body).collapsed;
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ ok: true });
      }

      if (url === '/api/projects' && options.method === 'POST') {
        extraProjectAdded = true;
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ ok: true }, 201);
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-a/sessions' && options.method === 'POST') {
        createdProjectSession = true;
        requests.push({
          url,
          method: options.method,
        });
        return jsonResponse(
          {
            thread: {
              id: 'thread-3',
              name: 'Project session',
              cwd: '/tmp/workspace-a',
            },
          },
          201,
        );
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.loadSessions();
  assert.equal(fakeDocument.sendButton.textContent, '发送');
  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(fakeDocument.interruptButton.hidden, true);
  assert.equal(fakeDocument.conversationTitle.textContent, '');
  assert.equal(fakeDocument.conversationStatus.dataset.statusTone, 'connected');
  assert.equal(fakeDocument.conversationStatus.textContent, '在线');
  await app.createProject('/tmp/workspace-b');
  await app.toggleProjectCollapsed('/tmp/workspace-a');
  app.openHistoryDialog('/tmp/workspace-a');
  app.selectHistoryDialogTab('archived');
  assert.equal(app.getState().historyDialogTab, 'archived');
  app.selectHistoryDialogTab('active');
  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );
  await app.addFocusedSession('/tmp/workspace-a', 'thread-2');
  fakeDocument.conversationScroll.scrollTop = 999;
  fakeDocument.conversationScroll.scrollHeight = 2048;
  await app.selectSession('thread-1');
  assert.equal(fakeDocument.conversationTitle.textContent, 'Hello session');
  assert.equal(fakeDocument.conversationStatus.dataset.statusTone, 'connected');
  assert.equal(fakeDocument.conversationStatus.textContent, '在线');
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /thread-status-dot/);
  app.setComposerDraft('continue with the refactor');
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.match(
    fakeDocument.conversationNav.innerHTML,
    /data-conversation-nav="top">到顶部<\/button><button class="thread-nav-button" type="button" data-conversation-nav="previous">上一回合<\/button>/,
  );
  assert.match(fakeDocument.conversationNav.innerHTML, /上一回合/);
  assert.match(fakeDocument.conversationNav.innerHTML, /下一回合/);
  assert.match(fakeDocument.conversationNav.innerHTML, /到底部/);
  fakeDocument.conversationScroll.scrollTop = 888;
  assert.equal(app.jumpConversationToTop(), 0);
  assert.equal(fakeDocument.conversationScroll.scrollTop, 0);
  assert.equal(app.jumpConversationToBottom(), 2048);
  assert.equal(fakeDocument.conversationScroll.scrollTop, 2048);
  await app.sendTurn('continue with the refactor');
  assert.equal(app.getState().composerDraft, '');
  assert.equal(fakeDocument.sendButton.textContent, '停止');
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'started');
  assert.equal(fakeDocument.interruptButton.hidden, true);
  await app.interruptTurn();
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'interrupting');
  assert.equal(fakeDocument.sendButton.textContent, '停止中…');
  assert.equal(fakeDocument.sendButton.disabled, true);
  fakeEventSource.emit({
    type: 'turn_completed',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
  const secondInterrupt = await app.interruptTurn();

  assert.equal(app.getState().projects[1].id, '/tmp/workspace-b');
  assert.equal(app.getState().selectedSessionId, 'thread-1');
  assert.equal(app.getState().systemStatus.backend.status, 'connected');
  assert.deepEqual(
    app.getState().projects[0].focusedSessions.map((session) => session.id),
    ['thread-1', 'thread-3', 'thread-2'],
  );
  assert.equal(app.getState().projects[0].collapsed, true);
  assert.equal(app.getState().historyDialogProjectId, null);
  assert.equal(app.getState().historyDialogTab, 'active');
  assert.equal(fakeDocument.historyDialog.open, false);
  assert.equal(fakeDocument.conversationScroll.scrollTop, 2048);
  assert.match(fakeDocument.conversationBody.innerHTML, /Hello session/);
  assert.equal(secondInterrupt, null);
  assert.equal(requests[0].body.cwd, '/tmp/workspace-b');
  assert.equal(requests[1].body.collapsed, true);
  assert.equal(requests[2].body.threadId, 'thread-2');
  assert.match(requests[3].body.text, /refactor/);
  assert.equal(requests[4].body.turnId, 'turn-2');
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'completed');
});

test('browser app windows large sessions from the latest turns and expands older turns near the top edge', async () => {
  const fakeDocument = createFakeDocument();
  fakeDocument.conversationScroll.__autoMeasureHeight = true;
  fakeDocument.conversationScroll.clientHeight = 720;
  const turns = Array.from({ length: 60 }, (_, index) => ({
    id: `turn-${index + 1}`,
    status: 'completed',
    items: [
      {
        type: 'agentMessage',
        id: `item-${index + 1}`,
        text: `Message ${index + 1}`,
      },
    ],
  }));

  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Large session',
                  cwd: '/tmp/workspace-a',
                  updatedAt: 42,
                  turns: [],
                },
              ],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Large session',
            cwd: '/tmp/workspace-a',
            updatedAt: 42,
            turns,
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({
          model: null,
          reasoningEffort: null,
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.conversationBody.innerHTML, /Turn 60/);
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /Turn 1/);
  assert.match(fakeDocument.conversationBody.innerHTML, /上方还有 36 个回合/);

  fakeDocument.conversationScroll.scrollTop = 0;
  fakeDocument.conversationScroll.dispatchEvent({ type: 'scroll' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(fakeDocument.conversationBody.innerHTML, /Turn 25/);
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /Turn 12/);
  assert.equal(fakeDocument.conversationScroll.scrollTop, 1440);
});

test('browser app loads approval mode, toggles it, and refreshes pending approvals after approval sse events', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  let approvalMode = 'manual';
  let pendingApprovals = [
    {
      id: 'approval-1',
      threadId: 'thread-1',
      kind: 'commandExecution',
      summary: 'Run npm test',
      detail: { command: 'npm test', cwd: '/tmp/workspace-a' },
      status: 'pending',
    },
  ];
  const requests = [];

  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Approval thread',
                  pendingApprovalCount: pendingApprovals.length,
                  waitingOnApproval: pendingApprovals.length > 0,
                  pendingApprovals,
                },
              ],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode' && (!options.method || options.method === 'GET')) {
        return jsonResponse({ mode: approvalMode });
      }

      if (url === '/api/approval-mode' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        approvalMode = body.mode;
        requests.push({ url, method: options.method, body });
        return jsonResponse({ mode: approvalMode });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Approval thread',
            cwd: '/tmp/workspace-a',
            pendingApprovalCount: pendingApprovals.length,
            waitingOnApproval: pendingApprovals.length > 0,
            pendingApprovals,
            turns: [],
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /<select[^>]*data-approval-mode-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="manual" selected>手动审批<\/option>/);
  assert.match(fakeDocument.conversationBody.innerHTML, /Run npm test/);
  assert.match(fakeDocument.conversationBody.innerHTML, /批准/);
  assert.match(fakeDocument.conversationBody.innerHTML, /拒绝/);

  await app.setApprovalMode('auto-approve');

  assert.equal(app.getState().approvalMode, 'auto-approve');
  assert.deepEqual(requests, [
    {
      url: '/api/approval-mode',
      method: 'POST',
      body: { mode: 'auto-approve' },
    },
  ]);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="auto-approve" selected>自动通过<\/option>/);

  pendingApprovals = [
    ...pendingApprovals,
    {
      id: 'approval-2',
      threadId: 'thread-1',
      kind: 'fileChange',
      summary: 'Review src\\/app.js',
      detail: { path: 'src/app.js' },
      status: 'pending',
    },
  ];
  fakeEventSource.emit({
    type: 'approval_requested',
    threadId: 'thread-1',
    payload: {
      approval: pendingApprovals[1],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(fakeDocument.conversationBody.innerHTML, /Review src\\\/app\.js/);

  pendingApprovals = [pendingApprovals[1]];
  fakeEventSource.emit({
    type: 'approval_resolved',
    threadId: 'thread-1',
    payload: {
      approval: {
        id: 'approval-1',
        threadId: 'thread-1',
        status: 'approved',
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /Run npm test/);
  assert.match(fakeDocument.conversationBody.innerHTML, /Review src\\\/app\.js/);
});

test('browser app loads session option catalogs, restores per-session settings, and disables controls for running sessions', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const settingsByThread = {
    'thread-1': { model: 'gpt-5.4', reasoningEffort: null, sandboxMode: 'workspace-write' },
    'thread-2': { model: null, reasoningEffort: 'high', sandboxMode: 'read-only' },
  };

  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Model thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
                {
                  id: 'thread-2',
                  name: 'Running thread',
                  runtime: {
                    turnStatus: 'started',
                    activeTurnId: 'turn-2',
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode' && (!options.method || options.method === 'GET')) {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [
            { value: '', label: '默认' },
            { value: 'gpt-5.4', label: 'gpt-5.4' },
          ],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'high', label: '高' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            sandboxMode: 'danger-full-access',
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse(settingsByThread['thread-1']);
      }

      if (url === '/api/sessions/thread-2/settings') {
        return jsonResponse(settingsByThread['thread-2']);
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Model thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-2',
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /<span class="approval-mode-label">/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="" selected>默认<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="gpt-5\.4" selected>gpt-5\.4<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="workspace-write" selected>工作区可写<\/option>/);
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: 'gpt-5.4',
    reasoningEffort: null,
    sandboxMode: 'workspace-write',
  });

  await app.selectSession('thread-2');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="high" selected>高<\/option>/);
  assert.deepEqual(app.getState().sessionSettingsById['thread-2'], {
    model: null,
    reasoningEffort: 'high',
    sandboxMode: 'read-only',
  });
});

test('browser app renders a compact composer task-summary band with expanded plan details and a placeholder fallback', async () => {
  const fakeDocument = createFakeDocument();
  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Planned thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
                {
                  id: 'thread-2',
                  name: 'No-plan thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Planned thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [
              {
                id: 'turn-0',
                status: 'completed',
                items: [
                  {
                    type: 'plan',
                    explanation: '这是更早的计划，不应该驱动摘要带。',
                    plan: [
                      { step: '旧计划：只验证旧入口', status: 'completed' },
                      { step: '旧计划：不会显示在新摘要', status: 'pending' },
                    ],
                  },
                ],
              },
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'plan',
                    explanation: '先收敛范围，再推进实现。',
                    plan: [
                      { step: '整理现有会话状态入口', status: 'completed' },
                      { step: '补齐紧凑摘要文案', status: 'completed' },
                      { step: '接入运行态动作语义', status: 'inProgress' },
                      { step: '收敛附件入口层级', status: 'pending' },
                      { step: '完成移动端折叠态', status: 'pending' },
                      { step: '回归验证', status: 'pending' },
                    ],
                  },
                ],
              },
              {
                id: 'turn-2',
                status: 'completed',
                items: [
                  {
                    type: 'agentMessage',
                    text: '后续回复没有新的计划更新。',
                  },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'No-plan thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [{ id: 'turn-2', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.composer.innerHTML, /已完成 2 个任务（共 6 个）/);
  assert.match(fakeDocument.composer.innerHTML, /data-task-summary-breakdown="true"/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /旧计划：只验证旧入口/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /旧计划：不会显示在新摘要/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /后续回复没有新的计划更新/);

  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'completed', '整理现有会话状态入口');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'completed', '补齐紧凑摘要文案');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'running', '接入运行态动作语义');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'upcoming', '收敛附件入口层级');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'upcoming', '完成移动端折叠态');

  await app.selectSession('thread-2');

  assert.doesNotMatch(fakeDocument.composer.innerHTML, /暂无任务计划/);
  assert.equal(fakeDocument.sessionDockPlanSummary.hidden, true);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /activity-card/);
});

test('browser app applies the new composer action hierarchy and surfaces blocked feedback inline', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const requests = [];
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method ?? 'GET',
      });

      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Busy thread',
                  waitingOnApproval: true,
                  pendingApprovalCount: 1,
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Busy thread',
            cwd: '/tmp/workspace-a',
            waitingOnApproval: true,
            pendingApprovalCount: 1,
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/interrupt') {
        return jsonResponse({ interrupted: true }, 202);
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/turn' && options.method === 'POST') {
        return jsonResponse({
          threadId: 'thread-1',
          turn: { id: 'turn-2', status: 'started', items: [] },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  const attachmentTriggerMatches = [
    ...fakeDocument.composer.innerHTML.matchAll(/data-composer-attach-trigger="true"/g),
  ];
  assert.equal(attachmentTriggerMatches.length, 1);
  assert.equal(fakeDocument.composerUploadFileButton.hidden, false);
  assert.equal(fakeDocument.composerUploadImageButton.hidden, true);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  app.setComposerDraft('ready to run');
  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
  assert.equal(fakeDocument.sendButton.dataset.action, 'interrupt');
  assert.match(fakeDocument.sendButton.textContent, /(中断|停止)/);

  fakeDocument.composer.dispatchEvent({
    type: 'submit',
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.some((request) => request.url === '/api/sessions/thread-1/interrupt'), true);
  assert.equal(
    requests.some((request) => request.url === '/api/turn' && request.method === 'POST'),
    false,
  );
  assert.equal(fakeDocument.sendButton.dataset.action, 'interrupting');
  assert.match(fakeDocument.sendButton.textContent, /停止/);
  assert.match(fakeDocument.composer.innerHTML, /等待审批后可继续发送/);
});

test('browser app renders compact settings metadata, collapses the mobile settings strip by default, and keeps controls disabled while busy', async () => {
  const fakeDocument = createFakeDocument({ mobile: true });
  const sandboxModeFromSessionOptions = 'workspace-write';
  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Idle thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
                {
                  id: 'thread-2',
                  name: 'Running thread',
                  runtime: {
                    turnStatus: 'started',
                    activeTurnId: 'turn-9',
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [
            { value: '', label: '默认' },
            { value: 'gpt-5.4', label: 'gpt-5.4' },
          ],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'high', label: '高' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            sandboxMode: 'danger-full-access',
          },
          runtimeContext: {
            sandboxMode: sandboxModeFromSessionOptions,
          },
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({ model: 'gpt-5.4', reasoningEffort: 'high', sandboxMode: 'workspace-write' });
      }

      if (url === '/api/sessions/thread-2/settings') {
        return jsonResponse({ model: null, reasoningEffort: null, sandboxMode: 'read-only' });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Idle thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'plan',
                    explanation: '先做紧凑摘要，再落地细节。',
                    plan: [
                      { step: '梳理状态源', status: 'completed' },
                      { step: '渲染摘要带', status: 'completed' },
                      { step: '对齐中断语义', status: 'inProgress' },
                      { step: '补齐阻塞反馈', status: 'pending' },
                      { step: '合并附件入口', status: 'pending' },
                      { step: '移动端折叠验证', status: 'pending' },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-9',
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.composer.innerHTML, /已完成 2 个任务（共 6 个）/);
  assert.match(fakeDocument.composer.innerHTML, /data-task-summary-collapsed="true"/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /梳理状态源/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-toggle="true"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /composer-settings-mobile-summary-label/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="model"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="reasoning"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="sandbox"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="approval"/);

  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'model', '模型', 'gpt-5.4');
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'reasoning', '推理强度', '高');
  assertComposerSetting(
    fakeDocument.approvalModeControls.innerHTML,
    'sandbox',
    '沙箱隔离类型',
    '工作区可写',
  );
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'approval', '审批模式', '手动审批');
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /工作区可写/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /title="模型"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="模型：gpt-5\.4"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="沙箱隔离类型：工作区可写"/);

  app.toggleComposerSettings();
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="false"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-confirm="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, />确认<\/button>/);

  await app.selectSession('thread-2');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-approval-mode-select="true"[^>]*disabled/);
});

test('browser app adds pasted images to the composer and keeps them sendable when the provider supports images', async () => {
  const fakeDocument = createFakeDocument();
  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: 'Image thread', preview: 'image' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Image thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'codex',
          attachmentCapabilities: {
            maxAttachments: 10,
            maxBytesPerAttachment: 20 * 1024 * 1024,
            acceptedMimePatterns: ['image/*'],
            supportsNonImageFiles: false,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  app.setComposerDraft('Review this screenshot');

  fakeDocument.composerInput.dispatchEvent({
    type: 'paste',
    clipboardData: {
      items: [
        createClipboardImageItem(
          createFakeFile({
            name: 'screenshot.png',
            type: 'image/png',
            text: 'fake-image-binary',
          }),
        ),
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.getState().composerAttachments.length, 1);
  assert.equal(fakeDocument.composerAttachments.hidden, false);
  assert.match(fakeDocument.composerAttachments.innerHTML, /screenshot\.png/);
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(fakeDocument.composerAttachmentError.hidden, true);
});

test('browser app blocks unsupported attachments for the active provider with an inline error', async () => {
  const fakeDocument = createFakeDocument();
  const requests = [];
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: 'Codex thread', preview: 'codex' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Codex thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'codex',
          attachmentCapabilities: {
            maxAttachments: 10,
            maxBytesPerAttachment: 20 * 1024 * 1024,
            acceptedMimePatterns: ['image/*'],
            supportsNonImageFiles: false,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      if (url === '/api/sessions/thread-1/turns') {
        requests.push({ url, method: options.method, body: JSON.parse(options.body ?? '{}') });
        return jsonResponse({ turnId: 'turn-2', status: 'started' }, 202);
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  app.setComposerDraft('Review this file');

  fakeDocument.composerFileInput.files = [
    createFakeFile({
      name: 'report.pdf',
      type: 'application/pdf',
      text: '%PDF-1.4',
    }),
  ];
  fakeDocument.composerFileInput.dispatchEvent({ type: 'change' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(fakeDocument.composerAttachmentError.hidden, false);
  assert.match(fakeDocument.composerAttachmentError.textContent, /Codex/);
  assert.match(fakeDocument.composerAttachmentError.textContent, /report\.pdf/);
  await app.sendTurn();
  assert.deepEqual(requests, []);
});

test('browser app shows an explicit unsupported-provider error when attachments are disabled for the active provider', async () => {
  const fakeDocument = createFakeDocument();
  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: 'Agent API thread', preview: 'agentapi' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Agent API thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'agentapi',
          attachmentCapabilities: {
            maxAttachments: 0,
            maxBytesPerAttachment: 0,
            acceptedMimePatterns: [],
            supportsNonImageFiles: false,
          },
          modelOptions: [],
          reasoningEffortOptions: [],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  app.setComposerDraft('This provider should reject attachments.');

  fakeDocument.composerFileInput.files = [
    createFakeFile({
      name: 'notes.txt',
      type: 'text/plain',
      text: 'hello',
    }),
  ];
  fakeDocument.composerFileInput.dispatchEvent({ type: 'change' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(fakeDocument.composerAttachmentError.hidden, false);
  assert.match(fakeDocument.composerAttachmentError.textContent, /Agent API/);
  assert.match(fakeDocument.composerAttachmentError.textContent, /不支持附件/);
});

test('browser app keeps attachments through pending first-send session creation until the send succeeds', async () => {
  const fakeDocument = createFakeDocument();
  const turnRequest = createDeferred();
  let createdProjectSession = false;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: createdProjectSession
                ? [{ id: 'thread-3', name: 'Draft thread', preview: 'new' }]
                : [],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'codex',
          attachmentCapabilities: {
            maxAttachments: 10,
            maxBytesPerAttachment: 20 * 1024 * 1024,
            acceptedMimePatterns: ['image/*'],
            supportsNonImageFiles: false,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-a/sessions' && options.method === 'POST') {
        createdProjectSession = true;
        return jsonResponse(
          {
            thread: {
              id: 'thread-3',
              name: 'Draft thread',
              cwd: '/tmp/workspace-a',
            },
          },
          201,
        );
      }

      if (url === '/api/sessions/thread-3') {
        return jsonResponse({
          thread: {
            id: 'thread-3',
            name: 'Draft thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-3/turns' && options.method === 'POST') {
        return turnRequest.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.startSessionInProject('/tmp/workspace-a');
  app.setComposerDraft('first message');
  await app.addComposerFiles([
    createFakeFile({
      name: 'shot.png',
      type: 'image/png',
      text: 'fake-image-binary',
    }),
  ]);

  const sendPromise = app.sendTurn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.getState().selectedSessionId, 'thread-3');
  assert.equal(app.getState().composerAttachments.length, 1);
  assert.match(fakeDocument.composerAttachments.innerHTML, /shot\.png/);

  turnRequest.resolve(jsonResponse({ turnId: 'turn-1', status: 'started' }, 202));
  await sendPromise;

  assert.equal(app.getState().composerAttachments.length, 0);
  assert.equal(fakeDocument.composerAttachments.hidden, true);
  assert.equal(app.getState().composerDraft, '');
});

test('browser app saves session settings, reverts failures, and sends current turn settings', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const requests = [];
  let failNextSettingsSave = false;
  let savedSettings = { model: 'gpt-5.4', reasoningEffort: null, sandboxMode: 'danger-full-access' };

  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Model thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode' && (!options.method || options.method === 'GET')) {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [
            { value: '', label: '默认' },
            { value: 'gpt-5.4', label: 'gpt-5.4' },
          ],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'medium', label: '中' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            sandboxMode: 'danger-full-access',
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings' && (!options.method || options.method === 'GET')) {
        return jsonResponse(savedSettings);
      }

      if (url === '/api/sessions/thread-1/settings' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        if (failNextSettingsSave) {
          failNextSettingsSave = false;
          return jsonErrorResponse({ error: 'settings failed' }, 500);
        }

        savedSettings = body;
        return jsonResponse(body);
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Model thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/turns') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        return jsonResponse({ turnId: 'turn-2', status: 'started' }, 202);
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const saveResult = await app.setSessionSettings('thread-1', {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });

  assert.deepEqual(saveResult, {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });

  failNextSettingsSave = true;
  const failedSave = await app.setSessionSettings('thread-1', {
    model: 'gpt-5.4',
    reasoningEffort: null,
    sandboxMode: 'read-only',
  });

  assert.equal(failedSave, null);
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });
  assert.match(fakeDocument.approvalModeControls.innerHTML, /settings failed/);

  app.setComposerDraft('continue');
  await app.sendTurn();

  assert.deepEqual(requests, [
    {
      url: '/api/sessions/thread-1/settings',
      method: 'POST',
      body: {
        model: null,
        reasoningEffort: 'medium',
        sandboxMode: 'workspace-write',
      },
    },
    {
      url: '/api/sessions/thread-1/settings',
      method: 'POST',
      body: {
        model: 'gpt-5.4',
        reasoningEffort: null,
        sandboxMode: 'read-only',
      },
    },
    {
      url: '/api/sessions/thread-1/turns',
      method: 'POST',
      body: {
        text: 'continue',
        model: null,
        reasoningEffort: 'medium',
        sandboxMode: 'workspace-write',
        attachments: [],
      },
    },
  ]);
});

test('browser app preserves backend-defined reasoning effort values without frontend whitelisting', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const requests = [];
  let savedSettings = { model: null, reasoningEffort: 'deep-think' };

  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Claude thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode' && (!options.method || options.method === 'GET')) {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'deep-think', label: 'Deep Think' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings' && (!options.method || options.method === 'GET')) {
        return jsonResponse(savedSettings);
      }

      if (url === '/api/sessions/thread-1/settings' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        savedSettings = body;
        return jsonResponse(body);
      }

      if (url === '/api/sessions/thread-1/turns' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        return jsonResponse({
          turnId: 'turn-1',
          status: 'started',
          thread: {
            id: 'thread-1',
            name: 'Claude thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-1',
              diff: null,
              realtime: { status: 'running', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Claude thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'deep-think',
  });
  assert.match(
    fakeDocument.approvalModeControls.innerHTML,
    /<option value="deep-think" selected>Deep Think<\/option>/,
  );

  app.setComposerDraft('use the configured reasoning');
  await app.sendTurn();

  assert.deepEqual(requests, [
    {
      url: '/api/sessions/thread-1/turns',
      method: 'POST',
      body: {
        text: 'use the configured reasoning',
        model: null,
        reasoningEffort: 'deep-think',
        attachments: [],
      },
    },
  ]);
});
