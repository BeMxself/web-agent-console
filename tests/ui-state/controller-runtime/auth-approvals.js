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
} from '../shared.js';


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

test('browser app delays project session creation until the first send and prevents duplicate creation requests', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let createdProjectSession = false;
  let createSessionRequestCount = 0;
  const createSessionGate = createDeferred();
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
        createSessionRequestCount += 1;
        await createSessionGate.promise;
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

  const firstSendPromise = app.sendTurn('first message');
  const secondSendPromise = app.sendTurn('first message');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(createSessionRequestCount, 1);
  assert.deepEqual(requests, [{ url: '/api/sessions', method: 'GET' }]);

  createSessionGate.resolve();
  await firstSendPromise;
  const secondSendResult = await secondSendPromise;

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
