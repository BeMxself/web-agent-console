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


test('browser app can close a project from the sidebar activity state', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  const confirmMessages = [];
  fakeDocument.defaultView.confirm = (message) => {
    confirmMessages.push(message);
    return true;
  };
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
  assert.deepEqual(confirmMessages, ['确认删除项目“workspace-b”？']);
});

test('browser app keeps a project when project deletion confirmation is canceled', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  const confirmMessages = [];
  fakeDocument.defaultView.confirm = (message) => {
    confirmMessages.push(message);
    return false;
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
  await app.closeProject('/tmp/workspace-b');

  assert.equal(app.getState().projects.length, 2);
  assert.match(fakeDocument.sessionList.innerHTML, /workspace-b/);
  assert.deepEqual(requests, []);
  assert.deepEqual(confirmMessages, ['确认删除项目“workspace-b”？']);
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

  // Simulate textarea shrink behavior in browsers: until height is reset,
  // scrollHeight may stay pinned to the previously expanded box height.
  Object.defineProperty(fakeDocument.composerInput, 'scrollHeight', {
    configurable: true,
    enumerable: true,
    get() {
      return fakeDocument.composerInput.style.height === '52px' ? 32 : 220;
    },
  });

  app.setComposerDraft('short');

  assert.equal(fakeDocument.composerInput.style.height, '52px');
  assert.equal(fakeDocument.composerInput.style.overflowY, 'hidden');
});
