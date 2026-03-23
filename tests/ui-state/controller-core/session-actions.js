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
} from '../shared.js';


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

