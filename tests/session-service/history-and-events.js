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

test('session service branches from an arbitrary historical user question with a replay fallback', async () => {
  const calls = [];
  const service = new CodexSessionService({
    activityStore: {
      async addProject() {},
      async addFocusedSession() {},
    },
    client: {
      onNotification() {
        return () => {};
      },
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/read') {
          return {
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
                      content: [{ type: 'text', text: 'Second question', text_elements: [] }],
                    },
                    {
                      type: 'agentMessage',
                      id: 'agent-2',
                      text: 'Second answer',
                    },
                  ],
                },
              ],
            },
          };
        }

        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-branch',
              name: 'Branch thread',
              cwd: '/tmp/workspace-a',
              turns: [],
            },
          };
        }

        if (method === 'thread/resume') {
          return {
            thread: {
              id: 'thread-branch',
              name: 'Branch thread',
              cwd: '/tmp/workspace-a',
              turns: [],
            },
          };
        }

        if (method === 'turn/start') {
          return { turnId: 'turn-branch', status: 'started' };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  });

  const result = await service.branchFromQuestion('thread-1', 'user-2', 'Edited second question');

  assert.equal(result.thread.id, 'thread-branch');
  assert.equal(result.turnId, 'turn-branch');
  const turnStart = calls.find((entry) => entry.method === 'turn/start');
  assert.ok(turnStart);
  assert.equal(turnStart.params.threadId, 'thread-branch');
  assert.match(turnStart.params.input[0].text, /Edited second question/);
  assert.match(turnStart.params.input[0].text, /Original question/);
  assert.match(turnStart.params.input[0].text, /Original answer/);
  assert.doesNotMatch(turnStart.params.input[0].text, /Second answer/);
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
