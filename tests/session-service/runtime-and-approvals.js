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
