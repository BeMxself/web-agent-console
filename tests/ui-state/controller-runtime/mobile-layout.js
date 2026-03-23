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
