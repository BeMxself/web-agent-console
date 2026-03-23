import { test, assert, reduceState } from '../shared.js';

test('ui reducer builds a live streaming turn from incremental item events', () => {
  let state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
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
    },
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-1' },
  });

  state = reduceState(state, {
    type: 'session_detail_loaded',
    payload: {
      thread: {
        id: 'thread-1',
        name: 'Focus thread',
        cwd: '/tmp/workspace-a',
        turns: [],
      },
    },
  });

  state = reduceState(state, {
    type: 'user_turn_submitted',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      text: 'Continue with the refactor',
    },
  });

  state = reduceState(state, {
    type: 'thread_item_started',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: {
        type: 'agentMessage',
        id: 'item-2',
        text: '',
        phase: 'commentary',
      },
    },
  });

  state = reduceState(state, {
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-2',
      delta: 'Streaming the analysis',
    },
  });

  state = reduceState(state, {
    type: 'thread_item_completed',
    payload: {
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
  });

  state = reduceState(state, {
    type: 'thread_item_started',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: {
        type: 'reasoning',
        id: 'item-reasoning-1',
        summary: [],
        content: [],
      },
    },
  });

  state = reduceState(state, {
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-reasoning-1',
      itemType: 'reasoning',
      deltaKind: 'reasoning_summary_part_added',
      summaryIndex: 0,
    },
  });

  state = reduceState(state, {
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-reasoning-1',
      itemType: 'reasoning',
      deltaKind: 'reasoning_summary_text',
      summaryIndex: 0,
      delta: 'Checking repo shape',
    },
  });

  state = reduceState(state, {
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-reasoning-1',
      itemType: 'reasoning',
      deltaKind: 'reasoning_text',
      contentIndex: 0,
      delta: 'Scanning files',
    },
  });

  state = reduceState(state, {
    type: 'thread_item_started',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: {
        type: 'commandExecution',
        id: 'item-command-1',
        command: 'npm test',
        cwd: '/tmp/workspace-a',
        processId: '123',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: '',
        exitCode: null,
        durationMs: null,
      },
    },
  });

  state = reduceState(state, {
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-command-1',
      itemType: 'commandExecution',
      deltaKind: 'command_output',
      delta: 'stdout line 1\n',
    },
  });

  state = reduceState(state, {
    type: 'thread_item_started',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: {
        type: 'mcpToolCall',
        id: 'item-mcp-1',
        server: 'openaiDeveloperDocs',
        tool: 'search_openai_docs',
        status: 'inProgress',
        arguments: { q: 'streaming ui' },
        result: null,
        error: null,
        durationMs: null,
      },
    },
  });

  state = reduceState(state, {
    type: 'thread_item_delta',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-mcp-1',
      itemType: 'mcpToolCall',
      deltaKind: 'mcp_progress',
      message: 'Searching docs',
    },
  });

  state = reduceState(state, {
    type: 'turn_completed',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });

  const thread = state.sessionDetailsById['thread-1'];
  assert.equal(thread.turns.length, 1);
  assert.equal(thread.turns[0].id, 'turn-2');
  assert.equal(thread.turns[0].status, 'completed');
  assert.equal(thread.turns[0].items[0].type, 'userMessage');
  assert.equal(thread.turns[0].items[1].text, 'Streaming the analysis');
  assert.equal(thread.turns[0].items[1].streaming, false);
  assert.equal(thread.turns[0].items[2].type, 'collabAgentToolCall');
  assert.equal(
    thread.turns[0].items[2].agentsStates['agent-thread-1'].message,
    'Inspecting layout containers',
  );
  assert.deepEqual(thread.turns[0].items[3].summary, ['Checking repo shape']);
  assert.deepEqual(thread.turns[0].items[3].content, ['Scanning files']);
  assert.equal(thread.turns[0].items[4].aggregatedOutput, 'stdout line 1\n');
  assert.deepEqual(thread.turns[0].items[5].progressMessages, ['Searching docs']);
});
