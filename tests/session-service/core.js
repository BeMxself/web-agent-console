import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeCodexServer } from '../helpers/fake-codex-app-server.js';
import { JsonRpcClient } from '../../src/lib/json-rpc-client.js';
import { SessionService } from '../../src/lib/session-service.js';
import { CodexSessionService } from '../../src/lib/codex-session-service.js';
import { RuntimeStore } from '../../src/lib/runtime-store.js';

const testDir = fileURLToPath(new URL('..', import.meta.url));

test('shared session service manages persisted settings without a codex client transport', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-shared-session-service-'));
  const filePath = join(tempDir, 'runtime-store.json');
  const runtimeStore = new RuntimeStore({ filePath });

  try {
    const service = new SessionService({ runtimeStore });

    await service.setSessionSettings('thread-1', {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });

    assert.deepEqual(await service.getSessionSettings('thread-1'), {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('shared session service supports deterministic pending actions with optional waiting and auto-approve reuse', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-shared-pending-actions-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const runtimeStore = new RuntimeStore({ filePath });
    const service = new SessionService({ runtimeStore });
    await service.setApprovalMode('manual');

    const firstRequest = await service.requestPendingAction({
      actionId: 'external-approval-1',
      threadId: 'thread-1',
      kind: 'tool_approval',
      summary: 'Allow Bash usage',
      payload: {
        approvalKind: 'unknown',
        detail: { command: ['npm', 'test'] },
        toolUseId: 'toolu-1',
      },
      waitForResolution: false,
    });

    assert.equal(firstRequest.pendingAction.id, 'external-approval-1');
    assert.equal(firstRequest.pendingAction.status, 'pending');
    assert.equal(firstRequest.result, null);
    assert.equal(service.listPendingApprovals('thread-1').length, 1);

    const waitingRequest = service.requestPendingAction({
      actionId: 'external-approval-1',
      threadId: 'thread-1',
      kind: 'tool_approval',
      summary: 'Allow Bash usage',
      payload: {
        approvalKind: 'unknown',
        detail: { command: ['npm', 'test'] },
        toolUseId: 'toolu-1',
      },
      waitForResolution: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const resolved = await service.resolvePendingAction('external-approval-1', {
      decision: 'approved',
    });
    const waited = await waitingRequest;

    assert.equal(resolved.status, 'approved');
    assert.equal(waited.pendingAction.id, 'external-approval-1');
    assert.deepEqual(waited.result, { decision: 'approved' });

    await service.setApprovalMode('auto-approve');
    const autoApproved = await service.requestPendingAction({
      actionId: 'external-approval-2',
      threadId: 'thread-1',
      kind: 'tool_approval',
      summary: 'Allow screenshot usage',
      payload: {
        approvalKind: 'unknown',
        detail: { permissions: ['screenshot'] },
        toolUseId: 'toolu-2',
      },
      waitForResolution: true,
    });
    const replayedAutoApproved = await service.requestPendingAction({
      actionId: 'external-approval-2',
      threadId: 'thread-1',
      kind: 'tool_approval',
      summary: 'Allow screenshot usage',
      payload: {
        approvalKind: 'unknown',
        detail: { permissions: ['screenshot'] },
        toolUseId: 'toolu-2',
      },
      waitForResolution: true,
    });

    assert.equal(autoApproved.pendingAction.status, 'auto-approved');
    assert.deepEqual(autoApproved.result, { decision: 'approved' });
    assert.equal(replayedAutoApproved.pendingAction.status, 'auto-approved');
    assert.deepEqual(replayedAutoApproved.result, { decision: 'approved' });
    assert.equal(service.listPendingApprovals('thread-1').length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('shared session service reconciles runtime snapshots through one persisted event path', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-shared-runtime-reconcile-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const runtimeStore = new RuntimeStore({ filePath });
    const service = new SessionService({ runtimeStore });
    const events = [];
    service.subscribe((event) => events.push(event));

    await service.reconcileRuntimeSnapshot(
      'thread-1',
      {
        turnStatus: 'started',
        activeTurnId: 'turn-1',
        source: 'claude-hook',
        realtime: {
          status: 'started',
          sessionId: 'claude-session-1',
        },
      },
      {
        threadStatus: {
          type: 'active',
          activeFlags: ['running'],
        },
      },
    );

    let persisted = await runtimeStore.load();
    assert.equal(persisted.threads['thread-1'].turnStatus, 'started');
    assert.equal(events[0].type, 'thread_status_changed');
    assert.equal(events[1].type, 'session_runtime_reconciled');

    await service.reconcileRuntimeSnapshot(
      'thread-1',
      {
        turnStatus: 'completed',
        activeTurnId: null,
        source: 'claude-hook',
        realtime: {
          status: 'completed',
          sessionId: 'claude-session-1',
          closeReason: 'completed',
        },
      },
      {
        threadStatus: {
          type: 'idle',
        },
        completedTurnId: 'turn-1',
      },
    );

    persisted = await runtimeStore.load();
    assert.equal(persisted.threads['thread-1'], undefined);
    assert.equal(
      events.filter((event) => event.type === 'turn_completed' && event.threadId === 'thread-1').length,
      1,
    );
    assert.equal(events.at(-2).type, 'turn_completed');
    assert.equal(events.at(-1).type, 'session_runtime_reconciled');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service lists, reads, starts, and resumes codex threads', async () => {
  const fakeServer = await createFakeCodexServer();
  const client = new JsonRpcClient(fakeServer.url);
  await client.connect();
  const service = new CodexSessionService({ client });

  const list = await service.listSessions();
  assert.equal(list.data[0].id, 'thread-1');

  const thread = await service.readSession('thread-1');
  assert.equal(thread.thread.id, 'thread-1');

  const started = await service.startSession({ cwd: '/tmp/workspace' });
  assert.equal(started.thread.id, 'thread-2');

  const resumed = await service.resumeSession('thread-1');
  assert.equal(resumed.thread.id, 'thread-1');

  await client.close();
  await fakeServer.close();
});

test('session service groups active and archived threads by project cwd', async () => {
  const calls = [];
  const service = new CodexSessionService({
    activityStore: {
      async load() {
        return {
          projects: {
            '/tmp/workspace-a': {
              collapsed: true,
              focusedThreadIds: ['active-1'],
            },
          },
        };
      },
    },
    client: {
      onNotification() {},
      async request(method, params) {
        calls.push({ method, params });
        if (method !== 'thread/list') {
          throw new Error(`Unexpected method: ${method}`);
        }

        if (params.archived) {
          return {
            data: [
              {
                id: 'archived-1',
                preview: 'older archived thread',
                updatedAt: 3,
                cwd: '/tmp/workspace-b',
                turns: [],
              },
            ],
          };
        }

        return {
          data: [
            {
              id: 'active-2',
              preview: 'older active thread',
              updatedAt: 4,
              cwd: '/tmp/workspace-a',
              turns: [],
            },
            {
              id: 'active-1',
              preview: 'latest active thread',
              updatedAt: 9,
              cwd: '/tmp/workspace-a',
              turns: [],
            },
          ],
        };
      },
    },
  });

  const result = await service.listProjects();

  assert.deepEqual(calls, [
    { method: 'thread/list', params: { archived: false } },
    { method: 'thread/list', params: { archived: true } },
  ]);
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects[0].cwd, '/tmp/workspace-a');
  assert.equal(result.projects[0].collapsed, true);
  assert.deepEqual(
    result.projects[0].focusedSessions.map((thread) => thread.id),
    ['active-1'],
  );
  assert.deepEqual(
    result.projects[0].historySessions.active.map((thread) => thread.id),
    ['active-2'],
  );
  assert.equal(result.projects[1].historySessions.archived[0].id, 'archived-1');
});

test('session service replays shared runtime state in project lists and session details', async () => {
  let handleNotification = () => {};
  const service = new CodexSessionService({
    activityStore: {
      async load() {
        return {
          projects: {
            '/tmp/workspace-a': {
              collapsed: false,
              focusedThreadIds: ['thread-1'],
            },
          },
        };
      },
    },
    client: {
      onNotification(handler) {
        handleNotification = handler;
      },
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived
              ? []
              : [
                  {
                    id: 'thread-1',
                    name: 'Running thread',
                    cwd: '/tmp/workspace-a',
                    updatedAt: 10,
                    turns: [],
                  },
                ],
          };
        }

        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Running thread',
              cwd: '/tmp/workspace-a',
              updatedAt: 10,
              turns: [],
            },
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  handleNotification({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-9',
    },
  });
  handleNotification({
    method: 'turn/diff/updated',
    params: {
      threadId: 'thread-1',
      diff: 'diff --git a/app.js b/app.js',
    },
  });
  handleNotification({
    method: 'thread/realtime/started',
    params: {
      threadId: 'thread-1',
      sessionId: 'rt-session-1',
    },
  });
  handleNotification({
    method: 'thread/realtime/itemAdded',
    params: {
      threadId: 'thread-1',
      item: {
        type: 'response.created',
        response: { id: 'resp-1' },
      },
    },
  });

  const projects = await service.listProjects();
  const detail = await service.readSession('thread-1');

  assert.equal(projects.projects[0].focusedSessions[0].runtime.turnStatus, 'started');
  assert.equal(projects.projects[0].focusedSessions[0].runtime.activeTurnId, 'turn-9');
  assert.equal(
    projects.projects[0].focusedSessions[0].runtime.diff,
    'diff --git a/app.js b/app.js',
  );
  assert.equal(projects.projects[0].focusedSessions[0].runtime.realtime.sessionId, 'rt-session-1');
  assert.equal(projects.projects[0].focusedSessions[0].runtime.realtime.items.length, 1);
  assert.equal(detail.thread.runtime.turnStatus, 'started');
  assert.equal(detail.thread.runtime.activeTurnId, 'turn-9');
  assert.equal(detail.thread.runtime.realtime.sessionId, 'rt-session-1');
  assert.equal(detail.thread.runtime.realtime.items[0].summary, 'response.created');
});

test('session service exposes session options and persists per-session settings', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-session-settings-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const runtimeStore = new RuntimeStore({ filePath });
    const client = {
      onNotification() {},
      async request(method) {
        if (method === 'thread/list') {
          return { data: [] };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    };
    const service = new CodexSessionService({
      client,
      runtimeStore,
      sandboxMode: 'danger-full-access',
    });

    const options = await service.getSessionOptions();
    const initialSettings = await service.getSessionSettings('thread-1');
    const savedSettings = await service.setSessionSettings('thread-1', {
      model: 'gpt-5.4',
      reasoningEffort: null,
      sandboxMode: 'workspace-write',
    });

    assert.deepEqual(options.defaults, {
      model: null,
      reasoningEffort: null,
      sandboxMode: 'danger-full-access',
    });
    assert.deepEqual(options.modelOptions[0], {
      value: '',
      label: '默认',
    });
    assert.deepEqual(options.reasoningEffortOptions[0], {
      value: '',
      label: '默认',
    });
    assert.deepEqual(options.sandboxModeOptions, [
      { value: 'read-only', label: '只读' },
      { value: 'workspace-write', label: '工作区可写' },
      { value: 'danger-full-access', label: '完全访问' },
    ]);
    assert.deepEqual(options.runtimeContext, {
      sandboxMode: 'danger-full-access',
    });
    assert.deepEqual(initialSettings, {
      model: null,
      reasoningEffort: null,
    });
    assert.deepEqual(savedSettings, {
      model: 'gpt-5.4',
      reasoningEffort: null,
      sandboxMode: 'workspace-write',
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(persisted.threadSettings['thread-1'], {
      model: 'gpt-5.4',
      reasoningEffort: null,
      sandboxMode: 'workspace-write',
    });

    const restoredService = new CodexSessionService({
      client,
      runtimeStore: new RuntimeStore({ filePath }),
    });
    assert.deepEqual(await restoredService.getSessionSettings('thread-1'), {
      model: 'gpt-5.4',
      reasoningEffort: null,
      sandboxMode: 'workspace-write',
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service forwards turn settings and omits default overrides', async () => {
  const requests = [];
  const service = new CodexSessionService({
    approvalPolicy: 'on-request',
    sandboxMode: 'danger-full-access',
    client: {
      onNotification() {},
      async request(method, params) {
        requests.push({ method, params });
        if (method === 'thread/resume') {
          return {
            thread: {
              id: params.threadId,
              name: 'Thread 1',
              cwd: '/tmp/workspace-a',
              status: { type: 'loaded' },
              turns: [],
            },
          };
        }

        if (method === 'turn/start') {
          return { turnId: 'turn-2', status: 'started' };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await service.startTurn('thread-1', 'continue', {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    sandboxMode: 'workspace-write',
  });
  await service.startTurn('thread-1', 'use defaults', {
    model: null,
    reasoningEffort: null,
    sandboxMode: null,
  });

  assert.deepEqual(requests[1], {
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'continue' }],
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'workspaceWrite',
      },
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    },
  });
  assert.deepEqual(requests[3], {
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'use defaults' }],
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'dangerFullAccess',
      },
    },
  });
});

test('session service maps image attachments to codex turn input items and preserves shared turn settings', async () => {
  const fakeServer = await createFakeCodexServer();
  const client = new JsonRpcClient(fakeServer.url);
  await client.connect();
  const service = new CodexSessionService({
    client,
    approvalPolicy: 'on-request',
    sandboxMode: 'danger-full-access',
  });

  try {
    const result = await service.startTurn('thread-1', {
      text: 'Review the screenshot',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      attachments: [
        {
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
        },
      ],
    });

    assert.equal(result.turnId, 'turn-2');
    const turnStartRequest = fakeServer
      .takeReceivedRequests()
      .find((request) => request.method === 'turn/start');
    assert.deepEqual(turnStartRequest?.params, {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'Review the screenshot' },
        { type: 'image', url: 'data:image/png;base64,Zm9v' },
      ],
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'dangerFullAccess',
      },
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });
  } finally {
    await client.close();
    await fakeServer.close();
  }
});

test('session service rejects non-image attachments before starting a codex turn', async () => {
  const requests = [];
  const service = new CodexSessionService({
    client: {
      onNotification() {},
      async request(method, params) {
        requests.push({ method, params });
        if (method === 'thread/resume') {
          return {
            thread: {
              id: params.threadId,
              name: 'Thread 1',
              cwd: '/tmp/workspace-a',
              status: { type: 'loaded' },
              turns: [],
            },
          };
        }

        if (method === 'turn/start') {
          return { turnId: 'turn-2', status: 'started' };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await assert.rejects(
    service.startTurn('thread-1', {
      text: 'Please review this PDF',
      attachments: [
        {
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 3,
          dataBase64: 'Zm9v',
        },
      ],
    }),
    /only supports image attachments/i,
  );

  assert.deepEqual(requests, [
    {
      method: 'thread/resume',
      params: { threadId: 'thread-1' },
    },
  ]);
});

