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

function createFakeBoundElement(overrides = {}) {
  const listeners = new Map();
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    open: false,
    hidden: false,
    dataset: {},
    addEventListener(type, handler) {
      if (!type || typeof handler !== 'function') {
        return;
      }

      const entries = listeners.get(type) ?? [];
      entries.push(handler);
      listeners.set(type, entries);
    },
    dispatchEvent(event) {
      const type = typeof event === 'string' ? event : event?.type;
      if (!type) {
        return false;
      }

      for (const handler of listeners.get(type) ?? []) {
        handler.call(this, event);
      }

      return true;
    },
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = Number(start);
      this.selectionEnd = Number(end);
    },
    querySelectorAll() {
      return [];
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.dispatchEvent({ type: 'close' });
    },
    ...overrides,
  };
}

function attachProjectDialog(fakeDocument) {
  const projectDialog = createFakeBoundElement();
  const projectDialogForm = createFakeBoundElement();
  const projectDialogInput = createFakeBoundElement();
  const originalQuerySelector = fakeDocument.querySelector.bind(fakeDocument);

  fakeDocument.projectDialog = projectDialog;
  fakeDocument.projectDialogForm = projectDialogForm;
  fakeDocument.projectDialogInput = projectDialogInput;
  fakeDocument.querySelector = (selector) => {
    if (selector === '#project-dialog') {
      return projectDialog;
    }

    if (selector === '#project-dialog-form') {
      return projectDialogForm;
    }

    if (selector === '#project-dialog-input') {
      return projectDialogInput;
    }

    return originalQuerySelector(selector);
  };

  return {
    projectDialog,
    projectDialogForm,
    projectDialogInput,
  };
}

function attachProjectDialogWithContinuityTracking(fakeDocument) {
  const projectDialogForm = createFakeBoundElement();
  const projectDialogInput = createFakeBoundElement({
    focus() {
      fakeDocument.activeElement = projectDialogInput;
    },
  });
  const projectDialogBody = createFakeBoundElement({ scrollTop: 0 });
  const projectDialog = createFakeBoundElement({
    querySelector(selector) {
      if (selector === '#project-dialog-input') {
        return projectDialogInput;
      }

      if (selector === '.project-dialog-browser-body') {
        return projectDialogBody;
      }

      return null;
    },
  });
  let innerHtml = '';
  let innerHtmlWrites = 0;
  Object.defineProperty(projectDialog, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      return innerHtml;
    },
    set(nextValue) {
      innerHtml = String(nextValue);
      innerHtmlWrites += 1;
      if (innerHtmlWrites > 1) {
        if (fakeDocument.activeElement === projectDialogInput) {
          fakeDocument.activeElement = null;
        }
        projectDialogBody.scrollTop = 0;
      }
    },
  });

  const originalQuerySelector = fakeDocument.querySelector.bind(fakeDocument);
  fakeDocument.projectDialog = projectDialog;
  fakeDocument.projectDialogForm = projectDialogForm;
  fakeDocument.projectDialogInput = projectDialogInput;
  fakeDocument.activeElement = null;
  fakeDocument.querySelector = (selector) => {
    if (selector === '#project-dialog') {
      return projectDialog;
    }

    if (selector === '#project-dialog-form') {
      return projectDialogForm;
    }

    if (selector === '#project-dialog-input') {
      return projectDialogInput;
    }

    return originalQuerySelector(selector);
  };

  return {
    projectDialog,
    projectDialogBody,
    projectDialogForm,
    projectDialogInput,
    get innerHtmlWrites() {
      return innerHtmlWrites;
    },
  };
}

function createClosestTarget(selector, dataset = {}) {
  return {
    closest(candidate) {
      if (candidate !== selector) {
        return null;
      }

      return { dataset };
    },
  };
}

function createMultiClosestTarget(entries = {}) {
  return {
    closest(selector) {
      const dataset = entries[selector];
      return dataset ? { dataset } : null;
    },
  };
}

test('browser app keeps add-project input focus, caret, and body scroll stable across the initial HOME browse load', async () => {
  const fakeDocument = createFakeDocument();
  const continuity = attachProjectDialogWithContinuityTracking(fakeDocument);
  const { projectDialog, projectDialogBody, projectDialogInput } = continuity;
  const homeDirectoryDeferred = createDeferred();
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

      if (url === '/api/local-files/list?path=') {
        return homeDirectoryDeferred.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const openPromise = app.openProjectDialog();

  assert.equal(projectDialog.open, true);
  assert.equal(fakeDocument.activeElement, projectDialogInput);

  projectDialogInput.value = '/Users/songmingxu/Projects';
  projectDialogInput.dispatchEvent({ type: 'input' });
  projectDialogInput.setSelectionRange(6, 17);
  projectDialogInput.focus();
  projectDialogBody.scrollTop = 91;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(fakeDocument.activeElement, projectDialogInput);
  assert.equal(projectDialogInput.selectionStart, 6);
  assert.equal(projectDialogInput.selectionEnd, 17);
  assert.equal(projectDialogBody.scrollTop, 91);

  homeDirectoryDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'songmingxu',
      path: '/Users/songmingxu',
      parentPath: '/Users',
      entries: [{ kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' }],
    }),
  );
  await openPromise;

  assert.equal(projectDialog.open, true);
  assert.equal(fakeDocument.activeElement, projectDialogInput);
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(projectDialogInput.value, '/Users/songmingxu/Projects');
  assert.equal(projectDialogInput.selectionStart, 6);
  assert.equal(projectDialogInput.selectionEnd, 17);
  assert.equal(projectDialogBody.scrollTop, 91);
});


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
  await app.loadSessionOptions();
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

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'codex',
          modelOptions: [],
          reasoningEffortOptions: [],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: null,
            sandboxMode: null,
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
  await app.loadSessionOptions();
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
  assert.equal(fakeDocument.sendButton.textContent, '发送');
  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'started');
  assert.equal(fakeDocument.interruptButton.hidden, false);
  await app.interruptTurn();
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'interrupted');
  assert.equal(fakeDocument.sendButton.textContent, '发送');
  assert.equal(fakeDocument.sendButton.disabled, true);
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
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'interrupted');
});

test('browser app restores an interrupted turn locally when the backend only returns interrupted true', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Busy thread' }],
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
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/sessions/thread-1/interrupt' && options.method === 'POST') {
        requests.push({ url, method: options.method, body: JSON.parse(options.body) });
        return jsonResponse({ interrupted: true }, 202);
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  app.setComposerDraft('');
  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });

  assert.equal(fakeDocument.interruptButton.hidden, false);
  assert.equal(fakeDocument.interruptButton.dataset.action, 'interrupt');
  assert.equal(fakeDocument.sendButton.dataset.action, 'busy');

  await app.interruptTurn();

  assert.deepEqual(requests, [
    {
      url: '/api/sessions/thread-1/interrupt',
      method: 'POST',
      body: { turnId: 'turn-2' },
    },
  ]);
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'interrupted');
  assert.equal(app.getState().activeTurnIdBySession['thread-1'], undefined);
  assert.equal(fakeDocument.interruptButton.hidden, true);
  assert.equal(fakeDocument.sendButton.dataset.action, 'send');
  assert.equal(fakeDocument.sendButton.textContent, '发送');
});

test('browser app allows codex sessions to send a follow-up prompt while a turn is running', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Codex thread' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'codex',
          modelOptions: [],
          reasoningEffortOptions: [],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: null,
            sandboxMode: null,
          },
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Codex thread',
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/sessions/thread-1/turns' && options.method === 'POST') {
        requests.push({ url, method: options.method, body: JSON.parse(options.body) });
        return jsonResponse({ turnId: 'turn-3', status: 'started' }, 202);
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  app.setComposerDraft('follow up while running');
  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });

  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(fakeDocument.sendButton.dataset.action, 'send');
  assert.equal(fakeDocument.sendButton.textContent, '发送');
  assert.equal(fakeDocument.interruptButton.hidden, false);
  assert.equal(fakeDocument.interruptButton.dataset.action, 'interrupt');

  fakeDocument.composer.dispatchEvent({
    type: 'submit',
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests, [
    {
      url: '/api/sessions/thread-1/turns',
      method: 'POST',
      body: {
        text: 'follow up while running',
        model: null,
        reasoningEffort: null,
        attachments: [],
      },
    },
  ]);
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'started');
});

test('browser app can collapse and restore the composer without losing the current draft', async () => {
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

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  app.setComposerDraft('keep this draft');
  assert.equal(fakeDocument.composer.dataset.collapsed, 'false');
  assert.equal(fakeDocument.composerCollapseToggle.textContent, '');
  assert.equal(fakeDocument.composerCollapseToggle.title, '压缩底栏');

  fakeDocument.composerCollapseToggle.dispatchEvent({ type: 'click' });

  assert.equal(app.getState().composerCollapsed, true);
  assert.equal(fakeDocument.composer.dataset.collapsed, 'true');
  assert.equal(fakeDocument.composerCollapseToggle.dataset.collapsed, 'true');
  assert.equal(fakeDocument.composerCollapseToggle.textContent, '');
  assert.equal(fakeDocument.composerCollapseToggle.title, '展开底栏');
  assert.equal(app.getState().composerDraft, 'keep this draft');

  fakeDocument.composerCollapseToggle.dispatchEvent({ type: 'click' });

  assert.equal(app.getState().composerCollapsed, false);
  assert.equal(fakeDocument.composer.dataset.collapsed, 'false');
  assert.equal(fakeDocument.composerCollapseToggle.dataset.collapsed, 'false');
  assert.equal(fakeDocument.composerCollapseToggle.textContent, '');
  assert.equal(fakeDocument.composerCollapseToggle.title, '压缩底栏');
  assert.equal(fakeDocument.composerInput.value, 'keep this draft');
});

test('browser app keeps add-project dialog draft state separate from the workspace file browser and submits the state-owned cwd draft', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  const { projectDialog, projectDialogForm, projectDialogInput } = attachProjectDialog(fakeDocument);
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

      if (url === '/api/local-files/list?path=%2Ftmp%2Fworkspace-a') {
        return jsonResponse({
          kind: 'directory',
          name: 'workspace-a',
          path: '/tmp/workspace-a',
          parentPath: '/tmp',
          entries: [{ kind: 'directory', name: 'src', path: '/tmp/workspace-a/src' }],
        });
      }

      if (url === '/api/local-files/list?path=') {
        return jsonResponse({
          kind: 'directory',
          name: 'songmingxu',
          path: '/Users/songmingxu',
          parentPath: '/Users',
          entries: [
            { kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' },
            { kind: 'directory', name: 'Downloads', path: '/Users/songmingxu/Downloads' },
          ],
        });
      }

      if (url === '/api/local-files/list?path=%2FUsers%2Fsongmingxu%2FProjects') {
        return jsonResponse({
          kind: 'directory',
          name: 'Projects',
          path: '/Users/songmingxu/Projects',
          parentPath: '/Users/songmingxu',
          entries: [
            {
              kind: 'directory',
              name: 'web-agent-console',
              path: '/Users/songmingxu/Projects/web-agent-console',
            },
          ],
        });
      }

      if (url === '/api/projects' && options.method === 'POST') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ ok: true }, 201);
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  await app.selectActivityPanelTab('files');
  assert.equal(app.getState().fileBrowser.currentPath, '/tmp/workspace-a');

  await app.openProjectDialog();
  assert.equal(projectDialog.open, true);
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu');
  assert.equal(app.getState().projectDialog.directoryBrowser.currentPath, '/Users/songmingxu');
  assert.equal(projectDialogInput.value, '/Users/songmingxu');
  assert.equal(app.getState().fileBrowser.currentPath, '/tmp/workspace-a');

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-tab]', {
      projectDialogTab: 'manual',
    }),
  });
  assert.equal(app.getState().projectDialog.tab, 'manual');
  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-tab]', {
      projectDialogTab: 'browse',
    }),
  });
  assert.equal(app.getState().projectDialog.tab, 'browse');

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-entry-path]', {
      projectDialogEntryPath: '/Users/songmingxu/Projects',
      projectDialogEntryKind: 'directory',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu/Projects',
  );
  assert.equal(app.getState().fileBrowser.currentPath, '/tmp/workspace-a');

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-parent-path]', {
      projectDialogParentPath: '/Users/songmingxu',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu');
  assert.equal(app.getState().projectDialog.directoryBrowser.currentPath, '/Users/songmingxu');

  projectDialogInput.value = '/tmp/workspace-b';
  projectDialogInput.dispatchEvent({ type: 'input' });
  assert.equal(projectDialogInput.value, '/tmp/workspace-b');

  projectDialogInput.value = '/tmp/ignored-by-submit';
  projectDialogForm.dispatchEvent({
    type: 'submit',
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests, [
    {
      url: '/api/projects',
      method: 'POST',
      body: { cwd: '/tmp/workspace-b' },
    },
  ]);
  assert.equal(app.getState().projectDialog, null);
  assert.equal(projectDialog.open, false);
  assert.equal(projectDialogInput.value, '');
});

test('browser app preserves a newer manual project dialog draft when the initial HOME browse response resolves late and reloads when returning to browse', async () => {
  const fakeDocument = createFakeDocument();
  const { projectDialog, projectDialogInput } = attachProjectDialog(fakeDocument);
  const homeDirectoryDeferred = createDeferred();
  const manualDirectoryDeferred = createDeferred();
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

      if (url === '/api/local-files/list?path=') {
        return homeDirectoryDeferred.promise;
      }

      if (url === '/api/local-files/list?path=%2FUsers%2Fsongmingxu%2FProjects') {
        return manualDirectoryDeferred.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const openPromise = app.openProjectDialog();
  assert.equal(projectDialog.open, true);
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, true);

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-tab]', {
      projectDialogTab: 'manual',
    }),
  });
  projectDialogInput.value = '/Users/songmingxu/Projects';
  projectDialogInput.dispatchEvent({ type: 'input' });

  assert.equal(app.getState().projectDialog.tab, 'manual');
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');

  homeDirectoryDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'songmingxu',
      path: '/Users/songmingxu',
      parentPath: '/Users',
      entries: [{ kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' }],
    }),
  );
  await openPromise;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(projectDialogInput.value, '/Users/songmingxu/Projects');
  assert.equal(app.getState().projectDialog.tab, 'manual');
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, false);
  assert.equal(app.getState().projectDialog.directoryBrowser.currentPath, null);
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, []);

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-tab]', {
      projectDialogTab: 'browse',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.getState().projectDialog.tab, 'browse');
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, true);

  manualDirectoryDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'Projects',
      path: '/Users/songmingxu/Projects',
      parentPath: '/Users/songmingxu',
      entries: [{ kind: 'directory', name: 'web-agent-console', path: '/Users/songmingxu/Projects/web-agent-console' }],
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu/Projects',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'web-agent-console', path: '/Users/songmingxu/Projects/web-agent-console' },
  ]);
  assert.equal(projectDialogInput.value, '/Users/songmingxu/Projects');
});

test('browser app does not refetch the project dialog browse directory when manual mode keeps the loaded draft intact', async () => {
  const fakeDocument = createFakeDocument();
  const { projectDialog, projectDialogInput } = attachProjectDialog(fakeDocument);
  let projectDirectoryRequestCount = 0;
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

      if (url === '/api/local-files/list?path=') {
        return jsonResponse({
          kind: 'directory',
          name: 'songmingxu',
          path: '/Users/songmingxu',
          parentPath: '/Users',
          entries: [{ kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' }],
        });
      }

      if (url === '/api/local-files/list?path=%2FUsers%2Fsongmingxu%2FProjects') {
        projectDirectoryRequestCount += 1;
        return jsonResponse({
          kind: 'directory',
          name: 'Projects',
          path: '/Users/songmingxu/Projects',
          parentPath: '/Users/songmingxu',
          entries: [{ kind: 'directory', name: 'web-agent-console', path: '/Users/songmingxu/Projects/web-agent-console' }],
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  await app.openProjectDialog();

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-entry-path]', {
      projectDialogEntryPath: '/Users/songmingxu/Projects',
      projectDialogEntryKind: 'directory',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(projectDirectoryRequestCount, 1);
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu/Projects',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'web-agent-console', path: '/Users/songmingxu/Projects/web-agent-console' },
  ]);

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-tab]', {
      projectDialogTab: 'manual',
    }),
  });
  projectDialogInput.value = '/Users/songmingxu/Projects';
  projectDialogInput.dispatchEvent({ type: 'input' });

  projectDialog.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-project-dialog-tab]', {
      projectDialogTab: 'browse',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.getState().projectDialog.tab, 'browse');
  assert.equal(projectDirectoryRequestCount, 1);
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu/Projects',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'web-agent-console', path: '/Users/songmingxu/Projects/web-agent-console' },
  ]);
});

test('browser app ignores stale out-of-order project dialog directory responses', async () => {
  const fakeDocument = createFakeDocument();
  attachProjectDialog(fakeDocument);
  const projectsDeferred = createDeferred();
  const downloadsDeferred = createDeferred();
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

      if (url === '/api/local-files/list?path=') {
        return jsonResponse({
          kind: 'directory',
          name: 'songmingxu',
          path: '/Users/songmingxu',
          parentPath: '/Users',
          entries: [
            { kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' },
            { kind: 'directory', name: 'Downloads', path: '/Users/songmingxu/Downloads' },
          ],
        });
      }

      if (url === '/api/local-files/list?path=%2FUsers%2Fsongmingxu%2FProjects') {
        return projectsDeferred.promise;
      }

      if (url === '/api/local-files/list?path=%2FUsers%2Fsongmingxu%2FDownloads') {
        return downloadsDeferred.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  await app.openProjectDialog();

  const firstLoadPromise = app.openProjectDialogDirectoryEntry(
    '/Users/songmingxu/Projects',
    'directory',
  );
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, true);

  const secondLoadPromise = app.openProjectDialogDirectoryEntry(
    '/Users/songmingxu/Downloads',
    'directory',
  );
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Downloads');
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, true);

  downloadsDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'Downloads',
      path: '/Users/songmingxu/Downloads',
      parentPath: '/Users/songmingxu',
      entries: [{ kind: 'directory', name: 'Screenshots', path: '/Users/songmingxu/Downloads/Screenshots' }],
    }),
  );
  await secondLoadPromise;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Downloads');
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu/Downloads',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'Screenshots', path: '/Users/songmingxu/Downloads/Screenshots' },
  ]);

  projectsDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'Projects',
      path: '/Users/songmingxu/Projects',
      parentPath: '/Users/songmingxu',
      entries: [{ kind: 'directory', name: 'web-agent-console', path: '/Users/songmingxu/Projects/web-agent-console' }],
    }),
  );
  await firstLoadPromise;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Downloads');
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu/Downloads',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'Screenshots', path: '/Users/songmingxu/Downloads/Screenshots' },
  ]);
});

test('browser app ignores stale project dialog directory responses after close and reopen', async () => {
  const fakeDocument = createFakeDocument();
  const { projectDialog } = attachProjectDialog(fakeDocument);
  const staleProjectsDeferred = createDeferred();
  const reopenedHomeDeferred = createDeferred();
  let homeRequestCount = 0;
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

      if (url === '/api/local-files/list?path=') {
        homeRequestCount += 1;
        if (homeRequestCount === 1) {
          return jsonResponse({
            kind: 'directory',
            name: 'songmingxu',
            path: '/Users/songmingxu',
            parentPath: '/Users',
            entries: [{ kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' }],
          });
        }

        return reopenedHomeDeferred.promise;
      }

      if (url === '/api/local-files/list?path=%2FUsers%2Fsongmingxu%2FProjects') {
        return staleProjectsDeferred.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => createFakeEventSource(),
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');
  await app.openProjectDialog();

  const staleLoadPromise = app.openProjectDialogDirectoryEntry(
    '/Users/songmingxu/Projects',
    'directory',
  );
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, true);

  projectDialog.close();
  assert.equal(app.getState().projectDialog, null);
  assert.equal(projectDialog.open, false);

  const reopenPromise = app.openProjectDialog();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.getState().projectDialog.cwdDraft, '');
  assert.equal(app.getState().projectDialog.directoryBrowser.loading, true);

  reopenedHomeDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'songmingxu',
      path: '/Users/songmingxu',
      parentPath: '/Users',
      entries: [{ kind: 'directory', name: 'Desktop', path: '/Users/songmingxu/Desktop' }],
    }),
  );
  await reopenPromise;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu');
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'Desktop', path: '/Users/songmingxu/Desktop' },
  ]);

  staleProjectsDeferred.resolve(
    jsonResponse({
      kind: 'directory',
      name: 'Projects',
      path: '/Users/songmingxu/Projects',
      parentPath: '/Users/songmingxu',
      entries: [{ kind: 'directory', name: 'stale', path: '/Users/songmingxu/Projects/stale' }],
    }),
  );
  await staleLoadPromise;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu');
  assert.equal(
    app.getState().projectDialog.directoryBrowser.currentPath,
    '/Users/songmingxu',
  );
  assert.deepEqual(app.getState().projectDialog.directoryBrowser.entries, [
    { kind: 'directory', name: 'Desktop', path: '/Users/songmingxu/Desktop' },
  ]);
});

test('browser app preserves add-project dialog draft focus and body scroll across unrelated project updates', async () => {
  const fakeDocument = createFakeDocument();
  const continuity = attachProjectDialogWithContinuityTracking(fakeDocument);
  const { projectDialog, projectDialogBody, projectDialogInput } = continuity;
  let sessionsResponse = {
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
  };
  const app = createAppController({
    fetchImpl: async (url) => {
      if (url === '/api/sessions') {
        return jsonResponse(sessionsResponse);
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

      if (url === '/api/local-files/list?path=') {
        return jsonResponse({
          kind: 'directory',
          name: 'songmingxu',
          path: '/Users/songmingxu',
          parentPath: '/Users',
          entries: [
            { kind: 'directory', name: 'Projects', path: '/Users/songmingxu/Projects' },
            { kind: 'directory', name: 'Downloads', path: '/Users/songmingxu/Downloads' },
          ],
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
  await app.openProjectDialog();

  assert.equal(projectDialog.open, true);

  projectDialogInput.value = '/Users/songmingxu/Projects';
  projectDialogInput.dispatchEvent({ type: 'input' });
  projectDialogInput.focus();
  projectDialogBody.scrollTop = 91;

  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(fakeDocument.activeElement, projectDialogInput);
  assert.equal(projectDialogBody.scrollTop, 91);
  const baselineInnerHtmlWrites = continuity.innerHtmlWrites;

  sessionsResponse = {
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [
          { id: 'thread-1', name: 'Focus thread' },
          { id: 'thread-2', name: 'New background thread' },
        ],
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
  };

  await app.loadSessions();

  assert.equal(projectDialog.open, true);
  assert.equal(continuity.innerHtmlWrites, baselineInnerHtmlWrites);
  assert.equal(app.getState().projectDialog.cwdDraft, '/Users/songmingxu/Projects');
  assert.equal(projectDialogInput.value, '/Users/songmingxu/Projects');
  assert.equal(fakeDocument.activeElement, projectDialogInput);
  assert.equal(projectDialogBody.scrollTop, 91);
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

test('browser app rewrites the last question into a branched session rerun', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  let sessionsResponseCount = 0;

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
              collapsed: false,
              focusedSessions:
                sessionsResponseCount > 1
                  ? [
                      { id: 'thread-1', name: 'Focus thread', cwd: '/tmp/workspace-a' },
                      { id: 'thread-branch', name: 'Branch thread', cwd: '/tmp/workspace-a' },
                    ]
                  : [{ id: 'thread-1', name: 'Focus thread', cwd: '/tmp/workspace-a' }],
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
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [{ type: 'text', text: 'Original question', text_elements: [] }],
                  },
                  {
                    type: 'agentMessage',
                    id: 'agent-1',
                    text: 'Original answer',
                  },
                ],
              },
              {
                id: 'turn-2',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-2',
                    content: [{ type: 'text', text: 'Latest question', text_elements: [] }],
                  },
                  {
                    type: 'agentMessage',
                    id: 'agent-2',
                    text: 'Stale answer',
                  },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-branch') {
        return jsonResponse({
          thread: {
            id: 'thread-branch',
            name: 'Branch thread',
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

      if (url === '/api/sessions/thread-1/branch' && options.method === 'POST') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse(
          {
            thread: {
              id: 'thread-branch',
              name: 'Branch thread',
              cwd: '/tmp/workspace-a',
            },
            turnId: 'turn-new',
            status: 'started',
          },
          202,
        );
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: 'gpt-5.4', label: 'gpt-5.4' }],
          reasoningEffortOptions: [{ value: 'high', label: 'high' }],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-rewrite-user-message]', {
      rewriteUserMessage: 'user-2',
    }),
  });

  assert.equal(fakeDocument.rewriteDialog.open, true);
  assert.equal(fakeDocument.rewriteDialogInput.value, 'Latest question');
  assert.equal(fakeDocument.rewriteDialogPrimaryButton.hidden, false);
  assert.equal(fakeDocument.rewriteDialogPrimaryButton.textContent, '新开分支重跑');
  assert.equal(fakeDocument.rewriteDialogSecondaryButton.hidden, false);
  assert.equal(fakeDocument.rewriteDialogSecondaryButton.textContent, '在当前会话重跑');

  fakeDocument.rewriteDialogInput.value = 'Edited question';
  fakeDocument.rewriteDialogForm.dispatchEvent({
    type: 'submit',
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.rewriteDialog.open, false);
  assert.equal(app.getState().selectedSessionId, 'thread-branch');
  assert.equal(app.getState().turnStatusBySession['thread-branch'], 'started');
  assert.match(fakeDocument.conversationBody.innerHTML, /Edited question/);
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /Original question/);
  const branchRequest = requests.find((entry) => entry.url === '/api/sessions/thread-1/branch');
  assert.ok(branchRequest);
  assert.deepEqual(branchRequest.body, {
    userMessageId: 'user-2',
    text: 'Edited question',
  });
});

test('browser app can rewrite from an arbitrary historical user question in the conversation', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
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
              focusedSessions:
                requests.length > 0
                  ? [
                      { id: 'thread-1', name: 'Focus thread', cwd: '/tmp/workspace-a' },
                      { id: 'thread-branch', name: 'Branch thread', cwd: '/tmp/workspace-a' },
                    ]
                  : [{ id: 'thread-1', name: 'Focus thread', cwd: '/tmp/workspace-a' }],
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
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [{ type: 'text', text: 'Original question', text_elements: [] }],
                  },
                  { type: 'agentMessage', id: 'agent-1', text: 'Original answer' },
                ],
              },
              {
                id: 'turn-2',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-2',
                    content: [{ type: 'text', text: 'Latest question', text_elements: [] }],
                  },
                  { type: 'agentMessage', id: 'agent-2', text: 'Latest answer' },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-branch') {
        return jsonResponse({
          thread: {
            id: 'thread-branch',
            name: 'Branch thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/branch' && options.method === 'POST') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse(
          {
            thread: {
              id: 'thread-branch',
              name: 'Branch thread',
              cwd: '/tmp/workspace-a',
            },
            turnId: 'turn-new',
            status: 'started',
          },
          202,
        );
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
        });
      }

      if (url === '/api/sessions/thread-1/settings' || url === '/api/sessions/thread-branch/settings') {
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
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.conversationBody.innerHTML, /data-rewrite-user-message="user-1"/);
  assert.match(fakeDocument.conversationBody.innerHTML, /data-rewrite-user-message="user-2"/);

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: {
      closest(selector) {
        if (selector === '[data-rewrite-user-message]') {
          return {
            dataset: {
              rewriteUserMessage: 'user-1',
            },
          };
        }
        return null;
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.rewriteDialog.open, true);
  assert.equal(fakeDocument.rewriteDialogInput.value, 'Original question');

  fakeDocument.rewriteDialogInput.value = 'Edited original question';
  fakeDocument.rewriteDialogForm.dispatchEvent({
    type: 'submit',
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.getState().selectedSessionId, 'thread-branch');
  assert.match(fakeDocument.conversationBody.innerHTML, /Edited original question/);
  assert.deepEqual(requests[0].body, {
    userMessageId: 'user-1',
    text: 'Edited original question',
  });
});

test('browser app can rewrite in place from a historical user question when the provider supports it', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
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
              focusedSessions: [{ id: 'thread-1', name: 'Focus thread', cwd: '/tmp/workspace-a' }],
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
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [{ type: 'text', text: 'Original question', text_elements: [] }],
                  },
                  { type: 'agentMessage', id: 'agent-1', text: 'Original answer' },
                ],
              },
              {
                id: 'turn-2',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-2',
                    content: [{ type: 'text', text: 'Latest question', text_elements: [] }],
                  },
                  { type: 'agentMessage', id: 'agent-2', text: 'Latest answer' },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-1/rewrite' && options.method === 'POST') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse(
          {
            thread: {
              id: 'thread-1',
              name: 'Focus thread',
              cwd: '/tmp/workspace-a',
            },
            turnId: 'turn-rewrite',
            status: 'started',
          },
          202,
        );
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
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
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createClosestTarget('[data-rewrite-user-message]', {
      rewriteUserMessage: 'user-2',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.rewriteDialogSecondaryButton.hidden, false);

  fakeDocument.rewriteDialogInput.value = 'Edited latest question';
  fakeDocument.rewriteDialogSecondaryButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.getState().selectedSessionId, 'thread-1');
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'started');
  assert.match(fakeDocument.conversationBody.innerHTML, /Edited latest question/);
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /Latest question/);
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /Latest answer/);
  assert.deepEqual(requests[0].body, {
    userMessageId: 'user-2',
    text: 'Edited latest question',
  });
});

test('browser app hides rewrite actions for user questions that include attachments', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Attachment thread', cwd: '/tmp/workspace-a' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Attachment thread',
            cwd: '/tmp/workspace-a',
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [
                      { type: 'text', text: 'Question with attachment', text_elements: [] },
                      { type: 'image', url: 'data:image/png;base64,Zm9v', name: 'diagram.png', mimeType: 'image/png' },
                    ],
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

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
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

  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, /data-rewrite-user-message=/);
  assert.equal(fakeDocument.rewriteDialog.open, false);
});

test('browser app copies card content with type-aware payloads from the conversation view', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Copy thread', cwd: '/tmp/workspace-a' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Copy thread',
            cwd: '/tmp/workspace-a',
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'commandExecution',
                    id: 'item-command-1',
                    command: 'npm test',
                    cwd: '/tmp/workspace-a',
                    status: 'completed',
                    aggregatedOutput: 'all tests passed',
                  },
                  {
                    type: 'mcpToolCall',
                    id: 'item-mcp-1',
                    server: 'docs',
                    tool: 'search',
                    status: 'completed',
                    arguments: { q: 'rewrite' },
                    result: { hits: 2 },
                    error: null,
                    progressMessages: ['searching'],
                  },
                  {
                    type: 'contextCompaction',
                    id: 'item-generic-1',
                    foo: 'bar',
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

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
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
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.conversationBody.innerHTML, /data-copy-thread-item="item-command-1"/);
  assert.match(fakeDocument.conversationBody.innerHTML, /data-copy-thread-item="item-mcp-1"/);
  assert.match(fakeDocument.conversationBody.innerHTML, /data-copy-thread-item="item-generic-1"/);

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createMultiClosestTarget({
      '[data-copy-thread-item]': {
        copyThreadItem: 'item-command-1',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(fakeDocument.defaultView.__clipboardWrites[0] ?? '', /npm test/);
  assert.match(fakeDocument.defaultView.__clipboardWrites[0] ?? '', /all tests passed/);

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createMultiClosestTarget({
      '[data-copy-thread-item]': {
        copyThreadItem: 'item-mcp-1',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(fakeDocument.defaultView.__clipboardWrites[1] ?? '', /docs/);
  assert.match(fakeDocument.defaultView.__clipboardWrites[1] ?? '', /"hits": 2/);

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createMultiClosestTarget({
      '[data-copy-thread-item]': {
        copyThreadItem: 'item-generic-1',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(fakeDocument.defaultView.__clipboardWrites[2] ?? '', /"type": "contextCompaction"/);
  assert.match(fakeDocument.defaultView.__clipboardWrites[2] ?? '', /"foo": "bar"/);
});

test('browser app copies assistant and commentary message text from the conversation view', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'Assistant copy thread', cwd: '/tmp/workspace-a' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Assistant copy thread',
            cwd: '/tmp/workspace-a',
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'agentMessage',
                    id: 'agent-commentary-1',
                    phase: 'commentary',
                    text: 'Thinking through the repository layout.',
                  },
                  {
                    type: 'agentMessage',
                    id: 'agent-final-1',
                    phase: 'final_answer',
                    text: 'Final answer body.',
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

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
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
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.conversationBody.innerHTML, /data-copy-thread-item="agent-commentary-1"/);
  assert.match(fakeDocument.conversationBody.innerHTML, /data-copy-thread-item="agent-final-1"/);

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createMultiClosestTarget({
      '[data-copy-thread-item]': {
        copyThreadItem: 'agent-commentary-1',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createMultiClosestTarget({
      '[data-copy-thread-item]': {
        copyThreadItem: 'agent-final-1',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.defaultView.__clipboardWrites.at(-2), 'Thinking through the repository layout.');
  assert.equal(fakeDocument.defaultView.__clipboardWrites.at(-1), 'Final answer body.');
});

test('browser app copies user message text while keeping the modify action', async () => {
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
              focusedSessions: [{ id: 'thread-1', name: 'User copy thread', cwd: '/tmp/workspace-a' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'User copy thread',
            cwd: '/tmp/workspace-a',
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [{ type: 'text', text: 'User message body', text_elements: [] }],
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

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          providerId: 'claude-sdk',
          rewriteCapabilities: {
            branch: true,
            inPlace: true,
          },
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: { model: null, reasoningEffort: null },
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
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.conversationBody.innerHTML, /data-rewrite-user-message="user-1"/);
  assert.match(fakeDocument.conversationBody.innerHTML, /data-copy-thread-item="user-1"/);
  assert.doesNotMatch(fakeDocument.conversationBody.innerHTML, />修改</);

  fakeDocument.conversationBody.dispatchEvent({
    type: 'click',
    preventDefault() {},
    target: createMultiClosestTarget({
      '[data-copy-thread-item]': {
        copyThreadItem: 'user-1',
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeDocument.defaultView.__clipboardWrites.at(-1), 'User message body');
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
