import {
  test,
  assert,
  createAppController,
  createFakeDocument,
  createFakeEventSource,
  createFakeStorage,
  createDeferred,
  trackInnerHtmlWrites,
  jsonResponse,
  jsonErrorResponse,
} from './shared.js';

test('browser app restores pending approvals after reconnect and keeps applying approval sse events', async () => {
  const approvalOne = {
    id: 'approval-1',
    threadId: 'thread-1',
    kind: 'commandExecution',
    summary: 'Run npm test',
    detail: { command: 'npm test', cwd: '/tmp/workspace-a' },
    status: 'pending',
  };
  const approvalTwo = {
    id: 'approval-2',
    threadId: 'thread-1',
    kind: 'fileChange',
    summary: 'Review src/app.js',
    detail: { path: 'src/app.js' },
    status: 'pending',
  };
  const fakeStorage = createFakeStorage();
  const eventSources = [];
  let pendingApprovals = [approvalOne];

  const fetchImpl = async (url, options = {}) => {
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
      return jsonResponse({ mode: 'manual' });
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
  };

  const eventSourceFactory = () => {
    const source = createFakeEventSource();
    eventSources.push(source);
    return source;
  };

  const firstDocument = createFakeDocument();
  const firstApp = createAppController({
    fetchImpl,
    eventSourceFactory,
    documentRef: firstDocument,
    storageImpl: fakeStorage,
  });

  await firstApp.loadSessions();
  await firstApp.loadApprovalMode();
  await firstApp.selectSession('thread-1');

  assert.equal(eventSources.length, 1);
  assert.match(firstDocument.conversationBody.innerHTML, /Run npm test/);

  firstApp.destroy();

  assert.equal(eventSources[0].closed, true);

  const secondDocument = createFakeDocument();
  const secondApp = createAppController({
    fetchImpl,
    eventSourceFactory,
    documentRef: secondDocument,
    storageImpl: fakeStorage,
  });

  await secondApp.loadSessions();
  await secondApp.loadApprovalMode();
  await secondApp.selectSession('thread-1');

  assert.equal(eventSources.length, 2);
  assert.match(secondDocument.conversationBody.innerHTML, /Run npm test/);

  pendingApprovals = [approvalOne, approvalTwo];
  eventSources[1].emit({
    type: 'approval_requested',
    threadId: 'thread-1',
    payload: {
      approval: approvalTwo,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(secondDocument.conversationBody.innerHTML, /Review src\/app\.js/);

  pendingApprovals = [approvalTwo];
  eventSources[1].emit({
    type: 'approval_resolved',
    threadId: 'thread-1',
    payload: {
      approval: {
        ...approvalOne,
        status: 'approved',
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(secondDocument.conversationBody.innerHTML, /Run npm test/);
  assert.match(secondDocument.conversationBody.innerHTML, /Review src\/app\.js/);
});

test('browser app prevents duplicate approval mode submissions and swallows approval-mode failures', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const modeRequest = createDeferred();
  let modeRequestCount = 0;
  let failModeRequest = false;
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
              focusedSessions: [],
              historySessions: { active: [], archived: [] },
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

      if (url === '/api/approval-mode' && options.method === 'POST') {
        modeRequestCount += 1;
        if (failModeRequest) {
          return jsonErrorResponse({ error: 'mode failed' }, 500);
        }

        return modeRequest.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadApprovalMode();

  const firstModeRequest = app.setApprovalMode('auto-approve');
  const secondModeRequest = app.setApprovalMode('manual');

  assert.equal(modeRequestCount, 1);

  modeRequest.resolve(jsonResponse({ mode: 'auto-approve' }));

  assert.deepEqual(await Promise.all([firstModeRequest, secondModeRequest]), [
    { mode: 'auto-approve' },
    null,
  ]);

  failModeRequest = true;
  const failedModeRequest = await app.setApprovalMode('manual');

  assert.equal(failedModeRequest, null);
});

test('browser app prevents duplicate approval resolutions and swallows approval resolution failures', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const approvalRequest = createDeferred();
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
  let approveRequestCount = 0;
  let denyRequestCount = 0;
  let failDenyRequest = false;
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
              historySessions: { active: [], archived: [] },
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

      if (url === '/api/approvals/approval-1/approve' && options.method === 'POST') {
        approveRequestCount += 1;
        return approvalRequest.promise;
      }

      if (url === '/api/approvals/approval-1/deny' && options.method === 'POST') {
        denyRequestCount += 1;
        if (failDenyRequest) {
          return jsonErrorResponse({ error: 'deny failed' }, 500);
        }

        return jsonResponse({ ok: true });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  const firstApproveRequest = app.approveRequest('approval-1');
  const secondApproveRequest = app.approveRequest('approval-1');

  assert.equal(approveRequestCount, 1);

  pendingApprovals = [];
  approvalRequest.resolve(jsonResponse({ ok: true }));

  assert.deepEqual(await Promise.all([firstApproveRequest, secondApproveRequest]), [
    { ok: true },
    null,
  ]);

  pendingApprovals = [
    {
      id: 'approval-1',
      threadId: 'thread-1',
      kind: 'commandExecution',
      summary: 'Run npm test',
      detail: { command: 'npm test', cwd: '/tmp/workspace-a' },
      status: 'pending',
    },
  ];
  failDenyRequest = true;
  const failedDenyRequest = await app.denyRequest('approval-1');

  assert.equal(denyRequestCount, 1);
  assert.equal(failedDenyRequest, null);
});

test('browser app stays on a login gate until shared-password auth succeeds, then can logout again', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage();
  let eventSourceCount = 0;
  let loginAttemptCount = 0;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/auth/session') {
        return jsonErrorResponse({ authenticated: false, required: true }, 401);
      }

      if (url === '/api/auth/login') {
        loginAttemptCount += 1;
        const { password } = JSON.parse(options.body ?? '{}');
        if (password !== 'demo-password') {
          return jsonErrorResponse({ error: '密码不正确' }, 401);
        }

        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'web-agent-auth=demo' },
        });
      }

      if (url === '/api/auth/logout') {
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'web-agent-auth=; Max-Age=0' },
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

      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: {
            model: null,
            reasoningEffort: null,
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => {
      eventSourceCount += 1;
      return createFakeEventSource();
    },
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.bootstrap();

  assert.equal(app.getState().auth.required, true);
  assert.equal(app.getState().auth.authenticated, false);
  assert.equal(fakeDocument.authGate.hidden, false);
  assert.equal(fakeDocument.appLayout.dataset.authLocked, 'true');
  assert.equal(fakeDocument.sessionList.hidden, false);
  assert.equal(fakeDocument.composer.hidden, false);
  assert.equal(fakeDocument.projectPanelToggle.hidden, false);
  assert.equal(fakeDocument.activityPanelToggle.hidden, false);
  assert.equal(eventSourceCount, 0);

  const failedLogin = await app.login('wrong-password');
  assert.equal(failedLogin, null);
  assert.equal(app.getState().auth.error, '密码不正确');
  assert.equal(loginAttemptCount, 1);
  assert.equal(eventSourceCount, 0);

  await app.login('demo-password');

  assert.equal(app.getState().auth.authenticated, true);
  assert.equal(fakeDocument.authGate.hidden, true);
  assert.equal(fakeDocument.appLayout.dataset.authLocked, 'false');
  assert.equal(fakeDocument.logoutButton.hidden, false);
  assert.equal(eventSourceCount, 1);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  await app.logout();

  assert.equal(app.getState().auth.authenticated, false);
  assert.equal(fakeDocument.authGate.hidden, false);
  assert.equal(fakeDocument.logoutButton.hidden, true);
});

test('browser app falls back to the login gate when a protected request later returns 401', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage();
  const fakeEventSource = createFakeEventSource();
  let sendTurnCount = 0;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/auth/session') {
        return jsonResponse({ authenticated: true, required: true });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/sessions') {
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: {
                active: [],
                archived: [],
              },
            },
          ],
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: {
            model: null,
            reasoningEffort: null,
          },
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/turns') {
        sendTurnCount += 1;
        return jsonErrorResponse({ error: 'Authentication required' }, 401);
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.bootstrap();
  await app.selectSession('thread-1');
  app.setComposerDraft('continue');

  const sendResult = await app.sendTurn('continue');

  assert.equal(sendResult, null);
  assert.equal(sendTurnCount, 1);
  assert.equal(app.getState().auth.required, true);
  assert.equal(app.getState().auth.authenticated, false);
  assert.equal(app.getState().selectedSessionId, null);
  assert.equal(fakeDocument.authGate.hidden, false);
  assert.equal(fakeDocument.appLayout.dataset.authLocked, 'true');
  assert.equal(fakeDocument.sessionList.hidden, false);
  assert.equal(fakeDocument.composer.hidden, false);
  assert.equal(fakeEventSource.closed, true);
});

test('browser app delays project session creation until the first send', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let createdProjectSession = false;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: createdProjectSession
                ? [{ id: 'thread-3', name: 'Project session' }]
                : [],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-a/sessions' && options.method === 'POST') {
        createdProjectSession = true;
        requests.push({ url, method: options.method });
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

      if (url === '/api/sessions/thread-3') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          thread: {
            id: 'thread-3',
            name: 'Project session',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-3/turns' && options.method === 'POST') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ turnId: 'turn-1', status: 'started' }, 202);
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

  await app.startSessionInProject('/tmp/workspace-a');

  assert.equal(app.getState().pendingSessionProjectId, '/tmp/workspace-a');
  assert.equal(app.getState().selectedSessionId, null);
  assert.equal(fakeDocument.conversationTitle.textContent, '新会话');
  assert.match(fakeDocument.conversationBody.innerHTML, /发送第一条消息后创建/);
  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.deepEqual(requests, [{ url: '/api/sessions', method: 'GET' }]);

  app.setComposerDraft('first message');

  assert.equal(fakeDocument.sendButton.disabled, false);

  await app.sendTurn('first message');

  assert.equal(app.getState().pendingSessionProjectId, null);
  assert.equal(app.getState().selectedSessionId, 'thread-3');
  assert.equal(app.getState().turnStatusBySession['thread-3'], 'started');
  assert.equal(fakeDocument.conversationTitle.textContent, 'Project session');
  assert.deepEqual(requests, [
    { url: '/api/sessions', method: 'GET' },
    { url: '/api/projects/%2Ftmp%2Fworkspace-a/sessions', method: 'POST' },
    { url: '/api/sessions', method: 'GET' },
    { url: '/api/sessions/thread-3', method: 'GET' },
    {
      url: '/api/sessions/thread-3/turns',
      method: 'POST',
      body: {
        text: 'first message',
        model: null,
        reasoningEffort: null,
        attachments: [],
      },
    },
  ]);
});

test('browser app refreshes background session titles and indicators after realtime updates', async () => {
  const requests = [];
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  let backgroundDetailReads = 0;
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
                { id: 'thread-1', name: 'Selected thread', preview: 'opened' },
                { id: 'thread-2', name: 'Old background name', preview: 'working' },
              ],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        requests.push(url);
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Selected thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        backgroundDetailReads += 1;
        requests.push(url);
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'Renamed background thread',
            preview: 'fresh reply',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-9', status: 'completed', items: [] }],
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-2', turnId: 'turn-2' },
  });

  assert.equal(app.getState().turnStatusBySession['thread-2'], 'started');
  assert.match(fakeDocument.sessionList.innerHTML, /session-status-indicator--busy/);

  fakeEventSource.emit({
    type: 'turn_completed',
    payload: { threadId: 'thread-2', turnId: 'turn-2' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(backgroundDetailReads, 1);
  assert.equal(app.getState().projects[0].focusedSessions[1].name, 'Renamed background thread');
  assert.equal(app.getState().unreadBySession['thread-2'], 1);
  assert.match(fakeDocument.sessionList.innerHTML, /Renamed background thread/);
  assert.match(fakeDocument.sessionList.innerHTML, /session-status-indicator--unread/);
  assert.equal(fakeDocument.conversationTitle.textContent, 'Selected thread');
});

test('browser app auto-scrolls an active selected session when streaming updates arrive', async () => {
  const fakeEventSource = createFakeEventSource();
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
              focusedSessions: [{ id: 'thread-1', name: 'Selected thread' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Selected thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  fakeDocument.conversationScroll.scrollTop = 120;
  fakeDocument.conversationScroll.scrollHeight = 4096;

  fakeEventSource.emit({
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-agent-1',
      delta: 'Streaming token by token',
    },
  });

  assert.equal(fakeDocument.conversationScroll.scrollTop, 4096);
  assert.match(fakeDocument.conversationBody.innerHTML, /Streaming token by token/);
});

test('browser app avoids rebuilding large thread markup for composer edits and status polling', async () => {
  const fakeDocument = createFakeDocument();
  const conversationWrites = trackInnerHtmlWrites(fakeDocument.conversationBody);
  const sidebarWrites = trackInnerHtmlWrites(fakeDocument.sessionList);
  const activityWrites = trackInnerHtmlWrites(fakeDocument.activityPanel);
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
              focusedSessions: [{ id: 'thread-1', name: 'Selected thread' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Selected thread',
            cwd: '/tmp/workspace-a',
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    text: 'Summarize the latest rollout state.',
                  },
                  {
                    type: 'agentMessage',
                    text: 'Here is a long thread body that should not be rebuilt when only the composer draft changes.',
                  },
                ],
              },
            ],
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

  const initialConversationWrites = conversationWrites.count;
  const initialSidebarWrites = sidebarWrites.count;
  const initialActivityWrites = activityWrites.count;

  app.setComposerDraft('continue the rollout');

  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(conversationWrites.count, initialConversationWrites);
  assert.equal(sidebarWrites.count, initialSidebarWrites);
  assert.equal(activityWrites.count, initialActivityWrites);

  await app.loadStatus();

  assert.equal(conversationWrites.count, initialConversationWrites);
  assert.equal(sidebarWrites.count, initialSidebarWrites);
  assert.equal(activityWrites.count, initialActivityWrites);
});

test('browser app reconciles interrupted runtime state after backend restart events', async () => {
  const fakeEventSource = createFakeEventSource();
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
              focusedSessions: [{ id: 'thread-1', name: 'Running thread', preview: 'working' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
  assert.match(fakeDocument.sessionList.innerHTML, /session-status-indicator--busy/);

  fakeEventSource.emit({
    type: 'session_runtime_reconciled',
    payload: {
      threadId: 'thread-1',
      runtime: {
        turnStatus: 'interrupted',
        activeTurnId: null,
        diff: 'diff --git a/app.js b/app.js',
        realtime: {
          status: 'interrupted',
          sessionId: 'rt-session-1',
          items: [],
          audioChunkCount: 0,
          audioByteCount: 0,
          lastAudio: null,
          lastError: 'app-server restarted before the running turn finished',
          closeReason: 'app-server restarted',
        },
      },
    },
  });

  assert.equal(app.getState().turnStatusBySession['thread-1'], 'interrupted');
  assert.equal(app.getState().activeTurnIdBySession['thread-1'], undefined);
  assert.doesNotMatch(fakeDocument.sessionList.innerHTML, /session-status-indicator--busy/);
  assert.match(fakeDocument.activityPanel.innerHTML, /app-server restarted before the running turn finished/);
  assert.match(fakeDocument.activityPanel.innerHTML, /interrupted/);
});

test('browser app hydrates shared runtime session state from loaded sessions and details', async () => {
  const fakeDocument = createFakeDocument();
  const runtime = {
    turnStatus: 'started',
    activeTurnId: 'turn-7',
    diff: 'diff --git a/app.js b/app.js',
    realtime: {
      status: 'started',
      sessionId: 'rt-session-1',
      items: [
        {
          index: 1,
          summary: 'response.created',
          value: { type: 'response.created', response: { id: 'resp-1' } },
        },
      ],
      audioChunkCount: 0,
      audioByteCount: 0,
      lastAudio: null,
      lastError: null,
      closeReason: null,
    },
  };

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
                  name: 'Running thread',
                  preview: 'working',
                  cwd: '/tmp/workspace-a',
                  runtime,
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
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime,
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
  });

  await app.loadSessions();

  assert.equal(app.getState().turnStatusBySession['thread-1'], 'started');
  assert.equal(app.getState().activeTurnIdBySession['thread-1'], 'turn-7');
  assert.equal(app.getState().realtimeBySession['thread-1'].sessionId, 'rt-session-1');
  assert.equal(app.getState().diffBySession['thread-1'], 'diff --git a/app.js b/app.js');
  assert.match(fakeDocument.sessionList.innerHTML, /session-status-indicator--busy/);

  await app.selectSession('thread-1');

  assert.match(fakeDocument.activityPanel.innerHTML, /rt-session-1/);
  assert.match(fakeDocument.activityPanel.innerHTML, /diff --git a\/app\.js b\/app\.js/);
  assert.match(fakeDocument.activityPanel.innerHTML, /response\.created/);
});

test('browser app refreshes the selected session detail after runtime reconciliation events', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  let detailRequestCount = 0;

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
              focusedSessions: [{ id: 'thread-1', name: 'Running thread', preview: 'working' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        detailRequestCount += 1;
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            turns:
              detailRequestCount === 1
                ? []
                : [
                    {
                      id: 'turn-2',
                      status: 'started',
                      items: [
                        {
                          id: 'item-1',
                          type: 'agentMessage',
                          text: 'Still working through the external rollout',
                        },
                      ],
                    },
                  ],
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');
  assert.equal(detailRequestCount, 1);

  fakeEventSource.emit({
    type: 'session_runtime_reconciled',
    payload: {
      threadId: 'thread-1',
      runtime: {
        turnStatus: 'started',
        activeTurnId: 'turn-2',
        diff: null,
        realtime: {
          status: 'idle',
          sessionId: null,
          items: [],
          audioChunkCount: 0,
          audioByteCount: 0,
          lastAudio: null,
          lastError: null,
          closeReason: null,
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(detailRequestCount, 2);
  assert.match(fakeDocument.conversationBody.innerHTML, /Still working through the external rollout/);
});

test('browser app can close a project from the sidebar activity state', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let projectClosed = false;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: projectClosed
            ? [
                {
                  id: '/tmp/workspace-a',
                  cwd: '/tmp/workspace-a',
                  displayName: 'workspace-a',
                  collapsed: false,
                  focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
                  historySessions: { active: [], archived: [] },
                },
              ]
            : [
                {
                  id: '/tmp/workspace-a',
                  cwd: '/tmp/workspace-a',
                  displayName: 'workspace-a',
                  collapsed: false,
                  focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
                  historySessions: { active: [], archived: [] },
                },
                {
                  id: '/tmp/workspace-b',
                  cwd: '/tmp/workspace-b',
                  displayName: 'workspace-b',
                  collapsed: false,
                  focusedSessions: [],
                  historySessions: { active: [], archived: [] },
                },
              ],
        });
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-b' && options.method === 'DELETE') {
        projectClosed = true;
        requests.push({ url, method: options.method });
        return jsonResponse({ ok: true });
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

  assert.equal(app.getState().projects.length, 2);
  assert.match(fakeDocument.sessionList.innerHTML, /workspace-b/);

  await app.closeProject('/tmp/workspace-b');

  assert.equal(app.getState().projects.length, 1);
  assert.equal(app.getState().projects[0].id, '/tmp/workspace-a');
  assert.doesNotMatch(fakeDocument.sessionList.innerHTML, /workspace-b/);
  assert.deepEqual(requests, [
    {
      url: '/api/projects/%2Ftmp%2Fworkspace-b',
      method: 'DELETE',
    },
  ]);
});

test('browser app can rename a selected session and sync the title plus project tree', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let threadName = 'Old session name';
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: threadName, cwd: '/tmp/workspace-a' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: threadName,
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/sessions/thread-1/name' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        threadName = body.name;
        requests.push({ url, method: options.method, body });
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: threadName,
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
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
  const renamed = await app.renameSession('thread-1', 'Renamed session');

  assert.equal(renamed.thread.name, 'Renamed session');
  assert.equal(fakeDocument.conversationTitle.textContent, 'Renamed session');
  assert.match(fakeDocument.conversationBody.innerHTML, /Renamed session/);
  assert.match(fakeDocument.sessionList.innerHTML, /Renamed session/);
  assert.deepEqual(requests, [
    {
      url: '/api/sessions',
      method: 'GET',
    },
    {
      url: '/api/sessions/thread-1',
      method: 'GET',
    },
    {
      url: '/api/sessions/thread-1/name',
      method: 'POST',
      body: { name: 'Renamed session' },
    },
    {
      url: '/api/sessions',
      method: 'GET',
    },
    {
      url: '/api/sessions/thread-1',
      method: 'GET',
    },
  ]);
});

test('browser app renders realtime summaries in the conversation and activity panel', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  fakeEventSource.emit({
    type: 'thread_realtime_started',
    payload: { threadId: 'thread-1', sessionId: 'rt-session-1' },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_item_added',
    payload: {
      threadId: 'thread-1',
      item: { type: 'response.created', response: { id: 'resp-1' } },
    },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_audio_delta',
    payload: {
      threadId: 'thread-1',
      audio: {
        data: 'AAA=',
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 480,
      },
    },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_error',
    payload: { threadId: 'thread-1', message: 'stream failed' },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_closed',
    payload: { threadId: 'thread-1', reason: 'completed' },
  });

  assert.match(fakeDocument.conversationBody.innerHTML, /rt-session-1/);
  assert.match(fakeDocument.conversationBody.innerHTML, /response\.created/);
  assert.match(fakeDocument.conversationBody.innerHTML, /stream failed/);
  assert.match(fakeDocument.activityPanel.innerHTML, /实时/);
  assert.match(fakeDocument.activityPanel.innerHTML, /closed/);
  assert.match(fakeDocument.activityPanel.innerHTML, /audio/i);
  assert.match(fakeDocument.activityPanel.innerHTML, /completed/);
});

test('browser app restores remembered panel preferences automatically and persists panel toggles', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage({
    'codex.webAgentConsole.preferences.v1': JSON.stringify({
      projectPanelCollapsed: true,
      activityPanelCollapsed: false,
      theme: 'light',
    }),
  });
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: { active: [], archived: [] },
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

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.loadSessions();

  assert.equal(app.getState().persistPanelPreference, true);
  assert.equal(app.getState().projectPanelCollapsed, true);
  assert.equal(app.getState().activityPanelCollapsed, false);
  assert.equal(fakeDocument.appLayout.dataset.projectPanel, 'collapsed');
  assert.equal(fakeDocument.appLayout.dataset.activityPanel, 'expanded');
  assert.equal(fakeDocument.appLayout.dataset.theme, 'light');

  app.toggleActivityPanel();

  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: true,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );

  app.openHistoryDialog('/tmp/workspace-a');
  assert.doesNotMatch(fakeDocument.historyDialog.innerHTML, /记住侧栏开关状态/);
  assert.doesNotMatch(fakeDocument.historyDialog.innerHTML, /data-panel-preference-toggle/);

  app.toggleProjectPanel();

  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );
});

test('browser app restores remembered dark theme preference and persists theme toggles', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage({
    'codex.webAgentConsole.preferences.v1': JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'dark',
    }),
  });
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: { active: [], archived: [] },
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

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.loadSessions();

  assert.equal(app.getState().theme, 'dark');
  assert.equal(fakeDocument.appLayout.dataset.theme, 'dark');
  assert.match(fakeDocument.sessionList.innerHTML, /data-theme-toggle="true"/);
  assert.match(fakeDocument.sessionList.innerHTML, /aria-label="切换到浅色主题"/);
  assert.match(fakeDocument.sessionList.innerHTML, /☀/);
  assert.equal(fakeDocument.authThemeToggle.dataset.themeNextTheme, 'light');
  assert.equal(fakeDocument.authThemeToggle.getAttribute('aria-label'), '切换到浅色主题');
  assert.match(fakeDocument.authThemeToggle.innerHTML, /☀/);

  app.toggleTheme();

  assert.equal(app.getState().theme, 'light');
  assert.equal(fakeDocument.appLayout.dataset.theme, 'light');
  assert.match(fakeDocument.sessionList.innerHTML, /aria-label="切换到暗色主题"/);
  assert.match(fakeDocument.sessionList.innerHTML, /☾/);
  assert.equal(fakeDocument.authThemeToggle.dataset.themeNextTheme, 'dark');
  assert.equal(fakeDocument.authThemeToggle.getAttribute('aria-label'), '切换到暗色主题');
  assert.match(fakeDocument.authThemeToggle.innerHTML, /☾/);
  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );
});

test('browser app auto-resizes the composer input from one line up to five lines', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: { active: [], archived: [] },
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

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  fakeDocument.composerInput.scrollHeight = 32;
  await app.loadSessions();

  assert.equal(fakeDocument.composerInput.style.height, '52px');
  assert.equal(fakeDocument.composerInput.style.overflowY, 'hidden');

  fakeDocument.composerInput.scrollHeight = 220;
  app.setComposerDraft('line 1\nline 2\nline 3\nline 4\nline 5\nline 6');

  assert.equal(fakeDocument.composerInput.style.height, '148px');
  assert.equal(fakeDocument.composerInput.style.overflowY, 'auto');
});

test('browser app syncs resizable sidebar widths and can hide the conversation nav controls', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread', preview: 'Live work' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
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
  app.toggleActivityPanel();

  app.setProjectPanelWidth(424);
  app.setActivityPanelWidth(296);

  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--project-panel-width'), '424px');
  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--activity-panel-width'), '296px');
  assert.equal(app.getState().projectPanelWidth, 424);
  assert.equal(app.getState().activityPanelWidth, 296);
  assert.equal(fakeDocument.conversationNavToggle.checked, true);
  assert.match(fakeDocument.conversationNav.innerHTML, /到顶部/);
  assert.match(fakeDocument.conversationNav.innerHTML, /上一回合/);

  app.setConversationNavVisible(false);

  assert.equal(app.getState().showConversationNav, false);
  assert.equal(fakeDocument.conversationNavToggle.checked, false);
  assert.equal(fakeDocument.conversationNav.innerHTML, '');

  app.toggleActivityPanel();

  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--activity-panel-width'), '0px');
  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--activity-resizer-width'), '0px');
});

test('browser app uses a full-screen mobile drawer for sessions and activity on small screens', async () => {
  const fakeDocument = createFakeDocument({ mobile: true });
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread', preview: 'Live work' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
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

  assert.equal(app.getState().mobileDrawerOpen, false);
  assert.equal(fakeDocument.mobileDrawer.open, false);
  assert.equal(fakeDocument.mobileDrawer.innerHTML, '');

  app.toggleProjectPanel();

  assert.equal(app.getState().mobileDrawerOpen, true);
  assert.equal(app.getState().mobileDrawerMode, 'sessions');
  assert.equal(fakeDocument.mobileDrawer.open, true);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /会话/);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /活动\/任务/);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /data-mobile-drawer-close="true"/);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /class="mobile-project-sidebar"/);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /退出登录/);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /data-theme-toggle="true"/);
  assert.match(fakeDocument.mobileDrawer.innerHTML, /Focus thread/);

  app.toggleActivityPanel();

  assert.equal(app.getState().mobileDrawerOpen, true);
  assert.equal(app.getState().mobileDrawerMode, 'activity');
  assert.match(fakeDocument.mobileDrawer.innerHTML, /活动\/任务/);
  assert.doesNotMatch(fakeDocument.mobileDrawer.innerHTML, /移动面板/);

  await app.selectSession('thread-1');

  assert.equal(app.getState().selectedSessionId, 'thread-1');
  assert.equal(app.getState().mobileDrawerOpen, false);
  assert.equal(fakeDocument.mobileDrawer.open, false);
  assert.equal(fakeDocument.conversationTitle.textContent, 'Focus thread');

  app.toggleActivityPanel();
  app.closeMobileDrawer();

  assert.equal(app.getState().mobileDrawerOpen, false);
  assert.equal(fakeDocument.mobileDrawer.open, false);
});

test('browser app enables send only when a selected session has draft text and no active turn', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();

  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  app.setComposerDraft('draft without session');
  assert.equal(fakeDocument.sendButton.disabled, true);

  await app.selectSession('thread-1');
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  app.setComposerDraft('   ');
  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  app.setComposerDraft('ship it');
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(fakeDocument.sendButton.textContent, '停止');

  fakeEventSource.emit({
    type: 'turn_completed',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(fakeDocument.sendButton.textContent, '发送');
});

test('browser app toggles project and activity panels from the conversation header', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
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

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();

  assert.equal(fakeDocument.appLayout.dataset.projectPanel, 'expanded');
  assert.equal(fakeDocument.appLayout.dataset.activityPanel, 'collapsed');
  assert.equal(fakeDocument.sessionList.hidden, false);
  assert.equal(fakeDocument.activityPanel.hidden, true);

  app.toggleActivityPanel();

  assert.equal(app.getState().activityPanelCollapsed, false);
  assert.equal(fakeDocument.appLayout.dataset.activityPanel, 'expanded');
  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--activity-panel-width'), '320px');
  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--activity-resizer-width'), '16px');
  assert.equal(fakeDocument.activityPanel.hidden, false);
  assert.equal(fakeDocument.activityPanelToggle.dataset.panelState, 'expanded');

  app.toggleProjectPanel();

  assert.equal(app.getState().projectPanelCollapsed, true);
  assert.equal(fakeDocument.appLayout.dataset.projectPanel, 'collapsed');
  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--project-panel-width'), '0px');
  assert.equal(fakeDocument.appLayout.style.getPropertyValue('--project-resizer-width'), '0px');
  assert.equal(fakeDocument.sessionList.hidden, true);
  assert.equal(fakeDocument.projectPanelToggle.dataset.panelState, 'collapsed');

  app.toggleActivityPanel();
  app.toggleProjectPanel();

  assert.equal(fakeDocument.appLayout.dataset.projectPanel, 'expanded');
  assert.equal(fakeDocument.appLayout.dataset.activityPanel, 'collapsed');
  assert.equal(fakeDocument.sessionList.hidden, false);
  assert.equal(fakeDocument.activityPanel.hidden, true);
});

test('browser app renders split activity and task sections in the right sidebar', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
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
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'started', items: [] }],
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  app.toggleActivityPanel();

  fakeEventSource.emit({
    type: 'turn_plan_updated',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: '先补协议再补 UI',
      plan: [
        { step: '对接结构化任务事件', status: 'completed' },
        { step: '右栏拆成活动和任务', status: 'inProgress' },
      ],
    },
  });

  assert.match(fakeDocument.activityPanel.innerHTML, /<h2>活动<\/h2>/);
  assert.match(fakeDocument.activityPanel.innerHTML, /<h2>任务列表<\/h2>/);
  assert.match(fakeDocument.activityPanel.innerHTML, /先补协议再补 UI/);
  assert.match(fakeDocument.activityPanel.innerHTML, /对接结构化任务事件/);
  assert.match(fakeDocument.activityPanel.innerHTML, /右栏拆成活动和任务/);
  assert.match(fakeDocument.activityPanel.innerHTML, /已完成/);
  assert.match(fakeDocument.activityPanel.innerHTML, /进行中/);
});

test('browser app shows backend status when session loading fails', async () => {
  const fakeDocument = createFakeDocument();
  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonErrorResponse({ error: 'WebSocket is not open: readyState 3 (CLOSED)' }, 500);
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'reconnecting',
          backend: { status: 'reconnecting' },
          relay: { status: 'online' },
          lastError: 'WebSocket is not open: readyState 3 (CLOSED)',
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadStatus();

  assert.equal(app.getState().loadError, 'WebSocket is not open: readyState 3 (CLOSED)');
  assert.equal(app.getState().systemStatus.backend.status, 'reconnecting');
  assert.equal(fakeDocument.conversationStatus.dataset.statusTone, 'reconnecting');
  assert.equal(fakeDocument.conversationStatus.textContent, '重连');
  assert.match(fakeDocument.sessionList.innerHTML, /后端重连中/);
  assert.match(fakeDocument.sessionList.innerHTML, /WebSocket is not open/);
});
