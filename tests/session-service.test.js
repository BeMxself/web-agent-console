import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeCodexServer } from './helpers/fake-codex-app-server.js';
import { JsonRpcClient } from '../src/lib/json-rpc-client.js';
import { SessionService } from '../src/lib/session-service.js';
import { CodexSessionService } from '../src/lib/codex-session-service.js';
import { RuntimeStore } from '../src/lib/runtime-store.js';

const testDir = dirname(fileURLToPath(import.meta.url));

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
    });

    assert.deepEqual(options.defaults, {
      model: null,
      reasoningEffort: null,
    });
    assert.deepEqual(options.modelOptions[0], {
      value: '',
      label: '默认',
    });
    assert.deepEqual(options.reasoningEffortOptions[0], {
      value: '',
      label: '默认',
    });
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
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(persisted.threadSettings['thread-1'], {
      model: 'gpt-5.4',
      reasoningEffort: null,
    });

    const restoredService = new CodexSessionService({
      client,
      runtimeStore: new RuntimeStore({ filePath }),
    });
    assert.deepEqual(await restoredService.getSessionSettings('thread-1'), {
      model: 'gpt-5.4',
      reasoningEffort: null,
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
  });
  await service.startTurn('thread-1', 'use defaults', {
    model: null,
    reasoningEffort: null,
  });

  assert.deepEqual(requests[1], {
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'continue' }],
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'dangerFullAccess',
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

test('session service reloads persisted inflight runtime snapshots across instances and can reconcile them', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-runtime-store-'));
  const filePath = join(tempDir, 'runtime-store.json');
  let notifyFirst = () => {};

  try {
    const runtimeStore = new RuntimeStore({ filePath });
    const service = new CodexSessionService({
      runtimeStore,
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
          notifyFirst = handler;
        },
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-1',
                      name: 'Recovered thread',
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
                name: 'Recovered thread',
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

    notifyFirst({
      method: 'turn/started',
      params: { threadId: 'thread-1', turnId: 'turn-42' },
    });
    notifyFirst({
      method: 'thread/realtime/started',
      params: { threadId: 'thread-1', sessionId: 'rt-session-42' },
    });
    await service.persistRuntimeSnapshot('thread-1');

    const reloadedService = new CodexSessionService({
      runtimeStore: new RuntimeStore({ filePath }),
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
        onNotification() {},
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-1',
                      name: 'Recovered thread',
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
                name: 'Recovered thread',
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

    const projects = await reloadedService.listProjects();
    assert.equal(projects.projects[0].focusedSessions[0].runtime.turnStatus, 'started');
    assert.equal(projects.projects[0].focusedSessions[0].runtime.activeTurnId, 'turn-42');

    const events = [];
    reloadedService.subscribe((event) => events.push(event));
    const interrupted = await reloadedService.markActiveSessionsInterrupted('app-server restarted');
    const reconciledProjects = await reloadedService.listProjects();

    assert.deepEqual(interrupted.threadIds, ['thread-1']);
    assert.equal(reconciledProjects.projects[0].focusedSessions[0].runtime.turnStatus, 'interrupted');
    assert.equal(reconciledProjects.projects[0].focusedSessions[0].runtime.activeTurnId, null);
    assert.equal(
      reconciledProjects.projects[0].focusedSessions[0].runtime.realtime.lastError,
      'app-server restarted before the running turn finished',
    );
    assert.equal(events[0].type, 'session_runtime_reconciled');
    assert.equal(events[0].payload.runtime.turnStatus, 'interrupted');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service restores approval mode and pending approvals from runtime store', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-approval-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const runtimeStore = new RuntimeStore({ filePath });
    await runtimeStore.save({
      version: 4,
      approvalMode: 'auto-approve',
      pendingActions: {
        'approval-1': {
          id: 'approval-1',
          threadId: 'thread-1',
          originThreadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          kind: 'tool_approval',
          summary: 'Run npm test',
          payload: {
            approvalKind: 'commandExecution',
            detail: {
              command: ['npm', 'test'],
              cwd: '/tmp/workspace-a',
            },
          },
          status: 'pending',
          createdAt: 10,
          resolvedAt: null,
          resolutionSource: null,
        },
        'question-1': {
          id: 'question-1',
          threadId: 'thread-1',
          originThreadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-2',
          kind: 'ask_user_question',
          summary: 'Choose a plan',
          payload: {
            prompt: 'Choose a plan',
            questions: [
              {
                header: 'Plan',
                question: 'Choose a plan',
                options: [
                  { label: 'Plan A', description: 'Proceed with plan A' },
                  { label: 'Plan B', description: 'Proceed with plan B' },
                ],
                multiSelect: false,
              },
            ],
          },
          status: 'pending',
          createdAt: 11,
          resolvedAt: null,
          resolutionSource: null,
        },
      },
      threads: {},
    });

    const service = new CodexSessionService({
      runtimeStore,
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
        onNotification() {},
        onRequest() {},
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-1',
                      name: 'Approval thread',
                      cwd: '/tmp/workspace-a',
                      updatedAt: 10,
                      status: { type: 'idle' },
                      turns: [],
                    },
                  ],
            };
          }

          if (method === 'thread/read') {
            return {
              thread: {
                id: 'thread-1',
                name: 'Approval thread',
                cwd: '/tmp/workspace-a',
                updatedAt: 10,
                status: { type: 'idle' },
                turns: [],
              },
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        },
      },
    });

    const projects = await service.listProjects();
    const detail = await service.readSession('thread-1');

    assert.equal(service.getApprovalMode().mode, 'auto-approve');
    assert.equal(projects.projects[0].focusedSessions[0].pendingApprovalCount, 1);
    assert.equal(projects.projects[0].focusedSessions[0].waitingOnApproval, true);
    assert.equal(projects.projects[0].focusedSessions[0].pendingApprovals.length, 1);
    assert.equal(
      projects.projects[0].focusedSessions[0].pendingApprovals[0].summary,
      'Run npm test',
    );
    assert.equal(detail.thread.pendingApprovalCount, 1);
    assert.equal(detail.thread.waitingOnApproval, true);
    assert.equal(detail.thread.pendingApprovals.length, 1);
    assert.equal(detail.thread.pendingApprovals[0].summary, 'Run npm test');
    assert.equal(projects.projects[0].focusedSessions[0].pendingQuestionCount, 1);
    assert.equal(projects.projects[0].focusedSessions[0].pendingQuestions.length, 1);
    assert.equal(projects.projects[0].focusedSessions[0].pendingQuestions[0].prompt, 'Choose a plan');
    assert.equal(detail.thread.pendingQuestionCount, 1);
    assert.equal(detail.thread.pendingQuestions.length, 1);
    assert.equal(detail.thread.pendingQuestions[0].prompt, 'Choose a plan');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service auto-approve mode only affects approval requests received after the mode switch', async () => {
  const service = new CodexSessionService({
    client: {
      onNotification() {},
      onRequest() {},
      async request() {
        throw new Error('Unexpected rpc request');
      },
    },
  });
  await service.setApprovalMode('manual');

  const manualPromise = service.handleApprovalRequest({
    id: 'approval-manual',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      command: 'npm test',
      cwd: '/tmp/workspace-a',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    service.listPendingApprovals('thread-1').map((entry) => entry.id),
    ['approval-manual'],
  );

  await service.setApprovalMode('auto-approve');
  const autoApproved = await service.handleApprovalRequest({
    id: 'approval-auto',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-2',
      command: 'npm run lint',
      cwd: '/tmp/workspace-a',
    },
  });
  const approvedManual = await service.approveRequest('approval-manual');

  assert.deepEqual(autoApproved, { decision: 'approved' });
  assert.deepEqual(approvedManual, { decision: 'approved' });
  assert.deepEqual(await manualPromise, { decision: 'approved' });
  assert.deepEqual(
    service.listPendingApprovals('thread-1').map((entry) => entry.id),
    [],
  );
  assert.equal(service.getApprovalRecord('approval-manual').status, 'approved');
  assert.equal(service.getApprovalRecord('approval-manual').resolutionSource, 'user');
  assert.equal(service.getApprovalRecord('approval-auto').status, 'auto-approved');
  assert.equal(service.getApprovalRecord('approval-auto').resolutionSource, 'auto');
});

test('session service defaults to auto-approve when no runtime snapshot exists', async () => {
  const service = new CodexSessionService({
    client: {
      onNotification() {},
      onRequest() {},
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived ? [] : [],
          };
        }

        throw new Error(`Unexpected rpc request: ${method}`);
      },
    },
  });

  await service.listProjects();

  assert.equal(service.getApprovalMode().mode, 'auto-approve');
  assert.deepEqual(
    await service.handleApprovalRequest({
      id: 'approval-default-auto',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: 'Take a screenshot for verification',
        permissions: ['screenshot'],
      },
    }),
    { decision: 'approved' },
  );
  assert.equal(service.getApprovalRecord('approval-default-auto').status, 'auto-approved');
});

test('session service remaps subagent approvals onto the parent session while preserving origin thread ids', async () => {
  const mainThread = {
    id: 'thread-main',
    name: 'Main thread',
    cwd: '/tmp/workspace-a',
    updatedAt: 10,
    status: { type: 'idle' },
    turns: [],
  };
  const childThread = {
    id: 'thread-child',
    name: 'Subagent thread',
    cwd: '/tmp/workspace-a',
    updatedAt: 11,
    status: { type: 'active', activeFlags: [] },
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: 'thread-main',
          depth: 1,
          agent_nickname: 'Tesla',
          agent_role: 'worker',
        },
      },
    },
    turns: [],
  };
  const service = new CodexSessionService({
    activityStore: {
      async load() {
        return {
          projects: {
            '/tmp/workspace-a': {
              collapsed: false,
              focusedThreadIds: ['thread-main'],
            },
          },
        };
      },
    },
    client: {
      onNotification() {},
      onRequest() {},
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived ? [] : [mainThread, childThread],
          };
        }

        if (method === 'thread/read') {
          return {
            thread: mainThread,
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await service.setApprovalMode('manual');
  await service.listProjects();

  const approvalPromise = service.handleApprovalRequest({
    id: 'approval-subagent',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-child',
      turnId: 'turn-child',
      itemId: 'item-child',
      command: 'npm test',
      cwd: '/tmp/workspace-a',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const projects = await service.listProjects();
  const detail = await service.readSession('thread-main');
  const approval = service.getApprovalRecord('approval-subagent');

  assert.equal(approval.threadId, 'thread-main');
  assert.equal(approval.originThreadId, 'thread-child');
  assert.deepEqual(
    service.listPendingApprovals('thread-main').map((entry) => entry.id),
    ['approval-subagent'],
  );
  assert.equal(projects.projects[0].focusedSessions[0].pendingApprovalCount, 1);
  assert.equal(projects.projects[0].focusedSessions[0].pendingApprovals[0].threadId, 'thread-main');
  assert.equal(
    projects.projects[0].focusedSessions[0].pendingApprovals[0].originThreadId,
    'thread-child',
  );
  assert.equal(detail.thread.pendingApprovalCount, 1);
  assert.equal(detail.thread.pendingApprovals[0].threadId, 'thread-main');
  assert.equal(detail.thread.pendingApprovals[0].originThreadId, 'thread-child');

  const resolution = await service.approveRequest('approval-subagent');
  assert.deepEqual(resolution, { decision: 'approved' });
  assert.deepEqual(await approvalPromise, { decision: 'approved' });
});

test('session service republishes pending approvals when subagent parent mapping is learned after approval arrives', async () => {
  let handleNotification = () => {};
  const service = new CodexSessionService({
    client: {
      onNotification(handler) {
        handleNotification = handler;
      },
      onRequest() {},
      async request() {
        throw new Error('Unexpected rpc request');
      },
    },
  });
  const events = [];
  service.subscribe((event) => events.push(event));
  await service.setApprovalMode('manual');

  const approvalPromise = service.handleApprovalRequest({
    id: 'approval-late-parent',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-child',
      turnId: 'turn-child',
      itemId: 'item-child',
      command: 'npm run build',
      cwd: '/tmp/workspace-a',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-main',
      turnId: 'turn-main',
      item: {
        type: 'collabAgentToolCall',
        id: 'item-collab-1',
        senderThreadId: 'thread-main',
        receiverThreadIds: ['thread-child'],
        agentsStates: {
          'thread-child': {
            status: 'running',
            message: 'Still working',
          },
        },
      },
    },
  });

  const approvalEvents = events.filter((event) => event.type === 'approval_requested');
  assert.deepEqual(
    approvalEvents.map((event) => event.threadId),
    ['thread-child', 'thread-main'],
  );
  assert.equal(approvalEvents[1].payload.approval.threadId, 'thread-main');
  assert.equal(approvalEvents[1].payload.approval.originThreadId, 'thread-child');
  assert.equal(service.getApprovalRecord('approval-late-parent').threadId, 'thread-main');
  assert.equal(service.getApprovalRecord('approval-late-parent').originThreadId, 'thread-child');
  assert.deepEqual(
    service.listPendingApprovals('thread-main').map((entry) => entry.id),
    ['approval-late-parent'],
  );

  const resolution = await service.approveRequest('approval-late-parent');
  assert.deepEqual(resolution, { decision: 'approved' });
  assert.deepEqual(await approvalPromise, { decision: 'approved' });
});

test('session service remaps restored subagent approvals onto parent sessions on the first project load', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-subagent-approval-store-'));
  const filePath = join(tempDir, 'runtime-store.json');

  try {
    const runtimeStore = new RuntimeStore({ filePath });
    await runtimeStore.save({
      version: 4,
      approvalMode: 'manual',
      pendingActions: {
        'approval-subagent': {
          id: 'approval-subagent',
          threadId: 'thread-child',
          originThreadId: 'thread-child',
          turnId: 'turn-child',
          itemId: 'item-child',
          kind: 'tool_approval',
          summary: 'Run npm test',
          payload: {
            approvalKind: 'commandExecution',
            detail: {
              command: ['npm', 'test'],
              cwd: '/tmp/workspace-a',
            },
          },
          status: 'pending',
          createdAt: 10,
          resolvedAt: null,
          resolutionSource: null,
        },
      },
      threads: {},
    });

    const service = new CodexSessionService({
      runtimeStore,
      activityStore: {
        async load() {
          return {
            projects: {
              '/tmp/workspace-a': {
                collapsed: false,
                focusedThreadIds: ['thread-main'],
              },
            },
          };
        },
      },
      client: {
        onNotification() {},
        onRequest() {},
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-main',
                      name: 'Main thread',
                      cwd: '/tmp/workspace-a',
                      updatedAt: 10,
                      status: { type: 'idle' },
                      turns: [],
                    },
                    {
                      id: 'thread-child',
                      name: 'Child thread',
                      cwd: '/tmp/workspace-a',
                      updatedAt: 11,
                      status: { type: 'active', activeFlags: [] },
                      source: {
                        subAgent: {
                          thread_spawn: {
                            parent_thread_id: 'thread-main',
                            depth: 1,
                            agent_nickname: 'Tesla',
                            agent_role: 'worker',
                          },
                        },
                      },
                      turns: [],
                    },
                  ],
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        },
      },
    });

    const projects = await service.listProjects();

    assert.equal(projects.projects[0].focusedSessions[0].pendingApprovalCount, 1);
    assert.equal(projects.projects[0].focusedSessions[0].pendingApprovals[0].threadId, 'thread-main');
    assert.equal(
      projects.projects[0].focusedSessions[0].pendingApprovals[0].originThreadId,
      'thread-child',
    );
    await assertApprovalThreadEventually(filePath, 'approval-subagent', 'thread-main');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service keeps waitingOnApproval in sync with thread status change notifications', async () => {
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
      onRequest() {},
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived
              ? []
              : [
                  {
                    id: 'thread-1',
                    name: 'Approval status thread',
                    cwd: '/tmp/workspace-a',
                    updatedAt: 10,
                    status: { type: 'idle' },
                    turns: [],
                  },
                ],
          };
        }

        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Approval status thread',
              cwd: '/tmp/workspace-a',
              updatedAt: 10,
              status: { type: 'idle' },
              turns: [],
            },
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await service.listProjects();

  handleNotification({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-1',
      status: {
        type: 'active',
        activeFlags: ['waitingOnApproval'],
      },
    },
  });

  const waitingDetail = await service.readSession('thread-1');

  handleNotification({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-1',
      status: {
        type: 'idle',
      },
    },
  });

  const idleDetail = await service.readSession('thread-1');

  assert.equal(waitingDetail.thread.waitingOnApproval, true);
  assert.equal(waitingDetail.thread.status.type, 'active');
  assert.equal(idleDetail.thread.waitingOnApproval, false);
  assert.equal(idleDetail.thread.status.type, 'idle');
});

test('session service strips provider worktree metadata from returned threads', async () => {
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
      onNotification() {},
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived
              ? []
              : [
                  {
                    id: 'thread-1',
                    name: 'Focused thread',
                    cwd: '/tmp/workspace-a',
                    worktree: {
                      root: '/tmp/session-1',
                    },
                    turns: [],
                  },
                ],
          };
        }

        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Focused thread',
              cwd: '/tmp/workspace-a',
              worktree: {
                root: '/tmp/session-1',
              },
              turns: [],
            },
          };
        }

        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-new',
              name: 'Started thread',
              cwd: '/tmp/workspace-a',
              worktree: {
                root: '/tmp/session-new',
              },
              turns: [],
            },
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  const projects = await service.listProjects();
  const detail = await service.readSession('thread-1');
  const started = await service.startSession({ cwd: '/tmp/workspace-a' });

  assert.equal(
    Object.hasOwn(projects.projects[0].focusedSessions[0], 'worktree'),
    false,
  );
  assert.equal(Object.hasOwn(detail.thread, 'worktree'), false);
  assert.equal(Object.hasOwn(started.thread, 'worktree'), false);
  assert.equal(Object.hasOwn(service.threadIndex.get('thread-1'), 'worktree'), false);
});

test('session service falls back to archived rollout files when codex cannot read thread details', async () => {
  const archivedPath = join(testDir, 'fixtures', 'archived-thread.jsonl');
  const service = new CodexSessionService({
    client: {
      onNotification() {},
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived
              ? [
                  {
                    id: 'archived-1',
                    preview: 'archived preview',
                    name: 'Archived thread',
                    updatedAt: 10,
                    createdAt: 8,
                    cwd: '/tmp/workspace-a',
                    path: archivedPath,
                    status: { type: 'notLoaded' },
                    turns: [],
                  },
                ]
              : [],
          };
        }

        if (method === 'thread/read') {
          throw new Error('failed to locate rollout for thread archived-1');
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await service.listProjects();
  const detail = await service.readSession('archived-1');

  assert.equal(detail.thread.id, 'archived-1');
  assert.equal(detail.thread.turns[0].items[0].type, 'userMessage');
  assert.match(detail.thread.turns[0].items[1].text, /Loading archived history/);
});

test('session service rollout fallback preserves user image blocks in normalized history', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-rollout-image-history-'));
  const archivedPath = join(tempDir, 'archived-thread-image.jsonl');
  await writeFile(
    archivedPath,
    [
      JSON.stringify({
        timestamp: '2026-03-18T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'archived-image-1',
          timestamp: '2026-03-18T00:00:00.000Z',
          cwd: '/tmp/workspace-a',
          cli_version: '0.115.0',
          source: 'vscode',
          model_provider: 'custom',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-18T00:00:00.100Z',
        type: 'turn_context',
        payload: {
          turn_id: 'turn-1',
          cwd: '/tmp/workspace-a',
          current_date: '2026-03-18',
          timezone: 'Asia/Shanghai',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-18T00:00:00.200Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Review screenshot' },
            { type: 'input_image', image_url: 'data:image/png;base64,Zm9v' },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-18T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1' },
      }),
    ].join('\n'),
    'utf8',
  );

  const service = new CodexSessionService({
    client: {
      onNotification() {},
      async request(method, params) {
        if (method === 'thread/list') {
          return {
            data: params.archived
              ? [
                  {
                    id: 'archived-image-1',
                    preview: 'archived image preview',
                    name: 'Archived image thread',
                    updatedAt: 10,
                    createdAt: 8,
                    cwd: '/tmp/workspace-a',
                    path: archivedPath,
                    status: { type: 'notLoaded' },
                    turns: [],
                  },
                ]
              : [],
          };
        }

        if (method === 'thread/read') {
          throw new Error('failed to locate rollout for thread archived-image-1');
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  try {
    await service.listProjects();
    const detail = await service.readSession('archived-image-1');
    assert.deepEqual(detail.thread.turns[0].items[0], {
      type: 'userMessage',
      id: 'item-1',
      content: [
        { type: 'text', text: 'Review screenshot', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,Zm9v' },
      ],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service falls back to the cached thread when a new session is not materialized yet', async () => {
  const service = new CodexSessionService({
    client: {
      onNotification() {},
      async request(method, params) {
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-new',
              preview: '',
              updatedAt: 10,
              createdAt: 10,
              cwd: '/tmp/workspace-a',
              status: { type: 'idle' },
              turns: [],
            },
          };
        }

        if (method === 'thread/read') {
          throw new Error(
            `thread ${params.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
          );
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await service.startSession({ cwd: '/tmp/workspace-a' });
  const detail = await service.readSession('thread-new');

  assert.equal(detail.thread.id, 'thread-new');
  assert.deepEqual(detail.thread.turns, []);
});

test('session service publishes normalized events for thread and turn updates', async () => {
  const fakeServer = await createFakeCodexServer({
    notifications: [
      { method: 'turn/started', params: { threadId: 'thread-1', turnId: 'turn-2' } },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          item: {
            type: 'agentMessage',
            id: 'item-2',
            text: '',
            phase: 'commentary',
          },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          itemId: 'item-2',
          delta: 'Analyzing the repository',
        },
      },
      {
        method: 'item/reasoning/summaryPartAdded',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          itemId: 'item-reasoning-1',
          summaryIndex: 0,
        },
      },
      {
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          itemId: 'item-reasoning-1',
          summaryIndex: 0,
          delta: 'Checking repo shape',
        },
      },
      {
        method: 'item/reasoning/textDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          itemId: 'item-reasoning-1',
          contentIndex: 0,
          delta: 'Scanning files',
        },
      },
      {
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          itemId: 'item-command-1',
          delta: 'stdout line 1',
        },
      },
      {
        method: 'item/mcpToolCall/progress',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          itemId: 'item-mcp-1',
          message: 'Searching docs',
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          item: {
            type: 'collabAgentToolCall',
            id: 'item-collab-1',
            tool: 'spawnAgent',
            status: 'inProgress',
            senderThreadId: 'thread-1',
            receiverThreadIds: ['agent-thread-1'],
            prompt: 'Inspect the CSS layout',
            model: 'gpt-5.2',
            reasoningEffort: 'medium',
            agentsStates: {
              'agent-thread-1': {
                status: 'running',
                message: 'Inspecting layout containers',
              },
            },
          },
        },
      },
      {
        method: 'turn/diff/updated',
        params: { threadId: 'thread-1', turnId: 'turn-2', diff: 'diff --git' },
      },
      { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-2' } },
    ],
  });
  const client = new JsonRpcClient(fakeServer.url);
  await client.connect();
  const service = new CodexSessionService({ client });
  const events = [];

  service.subscribe((event) => events.push(event));
  await service.listSessions();

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'turn_started',
      'thread_item_started',
      'thread_item_delta',
      'thread_item_delta',
      'thread_item_delta',
      'thread_item_delta',
      'thread_item_delta',
      'thread_item_delta',
      'thread_item_completed',
      'turn_diff_updated',
      'turn_completed',
    ],
  );
  assert.equal(events[1].payload.item.type, 'agentMessage');
  assert.equal(events[2].payload.delta, 'Analyzing the repository');
  assert.equal(events[3].payload.deltaKind, 'reasoning_summary_part_added');
  assert.equal(events[4].payload.deltaKind, 'reasoning_summary_text');
  assert.equal(events[5].payload.deltaKind, 'reasoning_text');
  assert.equal(events[6].payload.itemType, 'commandExecution');
  assert.equal(events[7].payload.itemType, 'mcpToolCall');
  assert.equal(events[8].payload.item.type, 'collabAgentToolCall');
  assert.equal(events[8].payload.item.agentsStates['agent-thread-1'].status, 'running');

  await client.close();
  await fakeServer.close();
});

test('session service resumes unloaded threads before starting a turn', async () => {
  const fakeServer = await createFakeCodexServer();
  const client = new JsonRpcClient(fakeServer.url);
  await client.connect();
  const service = new CodexSessionService({ client });

  const result = await service.startTurn('thread-1', 'Say hello in one sentence.');

  assert.equal(result.turnId, 'turn-2');

  await client.close();
  await fakeServer.close();
});

test('session service starts a turn even when resuming a newly created thread fails before rollout materializes', async () => {
  const calls = [];
  const service = new CodexSessionService({
    client: {
      onNotification() {
        return () => {};
      },
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/resume') {
          throw new Error(`no rollout found for thread id ${params.threadId}`);
        }

        if (method === 'turn/start') {
          return { turnId: 'turn-3', status: 'started' };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  const result = await service.startTurn('thread-new', 'Reply exactly TEST_OK and nothing else.');

  assert.equal(result.turnId, 'turn-3');
  assert.deepEqual(calls, [
    {
      method: 'thread/resume',
      params: { threadId: 'thread-new' },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'thread-new',
        input: [{ type: 'text', text: 'Reply exactly TEST_OK and nothing else.' }],
      },
    },
  ]);
});

test('session service resumes threads without requiring experimental history flags', async () => {
  const calls = [];
  const service = new CodexSessionService({
    client: {
      onNotification() {
        return () => {};
      },
      async request(method, params) {
        calls.push({ method, params });
        return { thread: { id: 'thread-1' } };
      },
    },
  });

  await service.resumeSession('thread-1');

  assert.deepEqual(calls[0], {
    method: 'thread/resume',
    params: { threadId: 'thread-1' },
  });
});

test('session service renames a session via thread/name/set and updates cached metadata', async () => {
  const calls = [];
  const service = new CodexSessionService({
    client: {
      onNotification() {
        return () => {};
      },
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/name/set') {
          return {};
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  service.rememberThreads([
    {
      id: 'thread-1',
      name: 'Old session name',
      preview: 'old preview',
      cwd: '/tmp/workspace-a',
      updatedAt: 9,
      turns: [],
    },
  ]);

  const renamed = await service.renameSession('thread-1', 'Renamed session');

  assert.deepEqual(calls, [
    {
      method: 'thread/name/set',
      params: { threadId: 'thread-1', name: 'Renamed session' },
    },
  ]);
  assert.equal(renamed.thread.id, 'thread-1');
  assert.equal(renamed.thread.name, 'Renamed session');
  assert.equal(service.threadIndex.get('thread-1').name, 'Renamed session');
  assert.equal(service.threadIndex.get('thread-1').preview, 'old preview');
});

test('session service updates the app activity store for focused sessions, hidden projects, and collapsed projects', async () => {
  const calls = [];
  const service = new CodexSessionService({
    activityStore: {
      async addFocusedSession(projectId, threadId) {
        calls.push({ method: 'addFocusedSession', projectId, threadId });
      },
      async removeFocusedSession(projectId, threadId) {
        calls.push({ method: 'removeFocusedSession', projectId, threadId });
      },
      async setCollapsed(projectId, collapsed) {
        calls.push({ method: 'setCollapsed', projectId, collapsed });
      },
      async hideProject(projectId) {
        calls.push({ method: 'hideProject', projectId });
      },
      async load() {
        return { projects: {} };
      },
    },
    client: {
      onNotification() {
        return () => {};
      },
      async request() {
        return { data: [] };
      },
    },
  });

  await service.addFocusedSession('/tmp/workspace-a', 'thread-1');
  await service.removeFocusedSession('/tmp/workspace-a', 'thread-1');
  await service.closeProject('/tmp/workspace-a');
  await service.setProjectCollapsed('/tmp/workspace-a', true);

  assert.deepEqual(calls, [
    {
      method: 'addFocusedSession',
      projectId: '/tmp/workspace-a',
      threadId: 'thread-1',
    },
    {
      method: 'removeFocusedSession',
      projectId: '/tmp/workspace-a',
      threadId: 'thread-1',
    },
    {
      method: 'hideProject',
      projectId: '/tmp/workspace-a',
    },
    {
      method: 'setCollapsed',
      projectId: '/tmp/workspace-a',
      collapsed: true,
    },
  ]);
});

test('session service hides projects that were closed in app activity state', async () => {
  const service = new CodexSessionService({
    activityStore: {
      async load() {
        return {
          projects: {
            '/tmp/workspace-a': {
              collapsed: false,
              focusedThreadIds: [],
              hidden: true,
            },
          },
        };
      },
    },
    client: {
      onNotification() {},
      async request(method, params) {
        if (method !== 'thread/list') {
          throw new Error(`Unexpected method: ${method}`);
        }

        return {
          data: params.archived
            ? []
            : [
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

  assert.deepEqual(result.projects, []);
});

test('session service can add an empty project to app-owned activity state', async () => {
  const calls = [];
  const service = new CodexSessionService({
    activityStore: {
      async addProject(projectId) {
        calls.push({ method: 'addProject', projectId });
      },
      async load() {
        return { projects: {} };
      },
    },
    client: {
      onNotification() {
        return () => {};
      },
      async request() {
        return { data: [] };
      },
    },
  });

  await service.addProject('/tmp/workspace-b');

  assert.deepEqual(calls, [{ method: 'addProject', projectId: '/tmp/workspace-b' }]);
});

test('session service starts and focuses a new session inside a project', async () => {
  const activityCalls = [];
  const requestCalls = [];
  const service = new CodexSessionService({
    approvalPolicy: 'on-request',
    sandboxMode: 'danger-full-access',
    activityStore: {
      async addProject(projectId) {
        activityCalls.push({ method: 'addProject', projectId });
      },
      async addFocusedSession(projectId, threadId) {
        activityCalls.push({ method: 'addFocusedSession', projectId, threadId });
      },
      async load() {
        return { projects: {} };
      },
    },
    client: {
      onNotification() {
        return () => {};
      },
      async request(method, params) {
        requestCalls.push({ method, params });
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-new',
              cwd: '/tmp/workspace-a',
              name: 'New session',
            },
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  const started = await service.createSessionInProject('/tmp/workspace-a');

  assert.equal(started.thread.id, 'thread-new');
  assert.deepEqual(requestCalls, [
    {
      method: 'thread/start',
      params: {
        cwd: '/tmp/workspace-a',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        experimentalRawEvents: false,
      },
    },
  ]);
  assert.deepEqual(activityCalls, [
    {
      method: 'addProject',
      projectId: '/tmp/workspace-a',
    },
    {
      method: 'addFocusedSession',
      projectId: '/tmp/workspace-a',
      threadId: 'thread-new',
    },
  ]);
});

test('session service lists newly created focused sessions even before thread/list materializes them', async () => {
  const service = new CodexSessionService({
    activityStore: {
      async addProject() {},
      async addFocusedSession() {},
      async load() {
        return {
          projects: {
            '/tmp/workspace-a': {
              collapsed: false,
              focusedThreadIds: ['thread-new'],
            },
          },
        };
      },
    },
    client: {
      onNotification() {
        return () => {};
      },
      async request(method, params) {
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-new',
              preview: '',
              updatedAt: 11,
              createdAt: 11,
              cwd: '/tmp/workspace-a',
              status: { type: 'idle' },
              turns: [],
            },
          };
        }

        if (method === 'thread/list') {
          return {
            data: params.archived ? [] : [],
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  await service.startSession({ cwd: '/tmp/workspace-a' });
  const result = await service.listProjects();

  assert.deepEqual(
    result.projects[0].focusedSessions.map((thread) => thread.id),
    ['thread-new'],
  );
});

test('session service surfaces external rollout activity as running runtime state', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-external-rollout-'));
  const rolloutPath = join(tempDir, 'rollout-thread.jsonl');

  try {
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-external',
            timestamp: '2026-03-20T00:00:00.000Z',
            cwd: '/tmp/workspace-a',
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: {
            turn_id: 'turn-external-1',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-external-1',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'Still working through the task',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const service = new CodexSessionService({
      activityStore: {
        async load() {
          return {
            projects: {
              '/tmp/workspace-a': {
                collapsed: false,
                focusedThreadIds: ['thread-external'],
              },
            },
          };
        },
      },
      client: {
        onNotification() {},
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-external',
                      name: 'External thread',
                      preview: 'running elsewhere',
                      cwd: '/tmp/workspace-a',
                      updatedAt: 10,
                      status: { type: 'notLoaded' },
                      path: rolloutPath,
                      turns: [],
                    },
                  ],
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        },
      },
    });

    const projects = await service.listProjects();
    const runtime = projects.projects[0].focusedSessions[0].runtime;

    assert.equal(runtime.turnStatus, 'started');
    assert.equal(runtime.activeTurnId, 'turn-external-1');
    assert.equal(runtime.source, 'externalRollout');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service reconciles external rollout runtime changes through explicit refreshes', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-external-rollout-refresh-'));
  const rolloutPath = join(tempDir, 'rollout-thread.jsonl');

  try {
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-external',
            timestamp: '2026-03-20T00:00:00.000Z',
            cwd: '/tmp/workspace-a',
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: {
            turn_id: 'turn-external-1',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-external-1',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const service = new CodexSessionService({
      activityStore: {
        async load() {
          return {
            projects: {
              '/tmp/workspace-a': {
                collapsed: false,
                focusedThreadIds: ['thread-external'],
              },
            },
          };
        },
      },
      client: {
        onNotification() {},
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-external',
                      name: 'External thread',
                      preview: 'running elsewhere',
                      cwd: '/tmp/workspace-a',
                      updatedAt: 10,
                      status: { type: 'notLoaded' },
                      path: rolloutPath,
                      turns: [],
                    },
                  ],
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        },
      },
    });

    const events = [];
    service.subscribe((event) => events.push(event));

    await service.listProjects();
    await appendFile(
      rolloutPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-external-1',
          last_agent_message: 'Done',
        },
      })}\n`,
      'utf8',
    );

    await service.refreshExternalRuntimeSnapshots();

    const projects = await service.listProjects();
    const runtime = projects.projects[0].focusedSessions[0].runtime;

    assert.equal(runtime.turnStatus, 'completed');
    assert.equal(runtime.activeTurnId, null);
    assert.equal(runtime.source, 'externalRollout');
    assert.equal(events.at(-1)?.type, 'session_runtime_reconciled');
    assert.equal(events.at(-1)?.payload?.runtime?.turnStatus, 'completed');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session service does not interrupt externally running rollout sessions during app-server restart reconciliation', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-external-rollout-reconcile-'));
  const rolloutPath = join(tempDir, 'rollout-thread.jsonl');

  try {
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-external',
            timestamp: '2026-03-20T00:00:00.000Z',
            cwd: '/tmp/workspace-a',
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: {
            turn_id: 'turn-external-1',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-external-1',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const service = new CodexSessionService({
      activityStore: {
        async load() {
          return {
            projects: {
              '/tmp/workspace-a': {
                collapsed: false,
                focusedThreadIds: ['thread-external'],
              },
            },
          };
        },
      },
      client: {
        onNotification() {},
        async request(method, params) {
          if (method === 'thread/list') {
            return {
              data: params.archived
                ? []
                : [
                    {
                      id: 'thread-external',
                      name: 'External thread',
                      preview: 'running elsewhere',
                      cwd: '/tmp/workspace-a',
                      updatedAt: 10,
                      status: { type: 'notLoaded' },
                      path: rolloutPath,
                      turns: [],
                    },
                  ],
            };
          }

          throw new Error(`Unexpected method: ${method}`);
        },
      },
    });

    await service.listProjects();
    const interrupted = await service.markActiveSessionsInterrupted('app-server restarted');
    const projects = await service.listProjects();
    const runtime = projects.projects[0].focusedSessions[0].runtime;

    assert.deepEqual(interrupted.threadIds, []);
    assert.equal(runtime.turnStatus, 'started');
    assert.equal(runtime.source, 'externalRollout');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function assertApprovalThreadEventually(filePath, approvalId, expectedThreadId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    if (persisted?.pendingActions?.[approvalId]?.threadId === expectedThreadId) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(
    JSON.parse(await readFile(filePath, 'utf8'))?.pendingActions?.[approvalId]?.threadId,
    expectedThreadId,
  );
}
