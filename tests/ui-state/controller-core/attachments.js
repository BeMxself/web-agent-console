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

