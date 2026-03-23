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
