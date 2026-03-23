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


test('browser app saves session settings, reverts failures, and sends current turn settings', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const requests = [];
  let failNextSettingsSave = false;
  let savedSettings = {
    model: 'gpt-5.4',
    reasoningEffort: null,
    agentType: null,
    sandboxMode: 'danger-full-access',
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
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
    agentType: 'plan',
    sandboxMode: 'workspace-write',
  });

  assert.deepEqual(saveResult, {
    model: null,
    reasoningEffort: 'medium',
    agentType: 'plan',
    sandboxMode: 'workspace-write',
  });
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'medium',
    agentType: 'plan',
    sandboxMode: 'workspace-write',
  });

  failNextSettingsSave = true;
  const failedSave = await app.setSessionSettings('thread-1', {
    model: 'gpt-5.4',
    reasoningEffort: null,
    agentType: null,
    sandboxMode: 'read-only',
  });

  assert.equal(failedSave, null);
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'medium',
    agentType: 'plan',
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
        agentType: 'plan',
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
        agentType: 'plan',
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
