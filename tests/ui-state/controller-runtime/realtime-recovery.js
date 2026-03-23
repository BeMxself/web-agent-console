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

