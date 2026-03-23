import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import {
  createAppController,
  findConversationTurnTarget,
  reduceState,
  renderProjectSidebar,
  renderHistoryDialog,
  renderThreadDetail,
} from '../public/app.js';
import { mapCodexNotification } from '../src/lib/codex-event-mapper.js';

globalThis.markdownit = (...args) => new MarkdownIt(...args);

function readPublicFile(name) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

test('codex mapper normalizes thread realtime notifications', () => {
  assert.deepEqual(
    mapCodexNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      },
    }),
    {
      type: 'turn_started',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'completed', items: [] },
      },
    }),
    {
      type: 'turn_completed',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'completed', items: [] },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/started',
      params: { threadId: 'thread-1', sessionId: 'rt-session-1' },
    }),
    {
      type: 'thread_realtime_started',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', sessionId: 'rt-session-1' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/itemAdded',
      params: {
        threadId: 'thread-1',
        item: { type: 'response.created', response: { id: 'resp-1' } },
      },
    }),
    {
      type: 'thread_realtime_item_added',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        item: { type: 'response.created', response: { id: 'resp-1' } },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/outputAudio/delta',
      params: {
        threadId: 'thread-1',
        audio: {
          data: 'AAA=',
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 480,
        },
      },
    }),
    {
      type: 'thread_realtime_audio_delta',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        audio: {
          data: 'AAA=',
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 480,
        },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/error',
      params: { threadId: 'thread-1', message: 'stream failed' },
    }),
    {
      type: 'thread_realtime_error',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', message: 'stream failed' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/closed',
      params: { threadId: 'thread-1', reason: 'completed' },
    }),
    {
      type: 'thread_realtime_closed',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', reason: 'completed' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/name/updated',
      params: { threadId: 'thread-1', name: 'Renamed session' },
    }),
    {
      type: 'thread_name_updated',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', name: 'Renamed session' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        explanation: '先补协议再补 UI',
        plan: [
          { step: '对接结构化任务事件', status: 'completed' },
          { step: '右栏拆成活动和任务', status: 'inProgress' },
        ],
      },
    }),
    {
      type: 'turn_plan_updated',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        explanation: '先补协议再补 UI',
        plan: [
          { step: '对接结构化任务事件', status: 'completed' },
          { step: '右栏拆成活动和任务', status: 'inProgress' },
        ],
      },
    },
  );
});

test('ui reducer stores grouped projects, selected thread, and turn events', () => {
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
            active: [{ id: 'thread-3', name: 'Working thread' }],
            archived: [{ id: 'thread-2', name: 'Older archived thread' }],
          },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'history_dialog_opened',
    payload: { projectId: '/tmp/workspace-a' },
  });

  state = reduceState(state, {
    type: 'history_dialog_tab_selected',
    payload: { tab: 'archived' },
  });

  state = reduceState(state, {
    type: 'history_dialog_closed',
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-2' },
  });

  state = reduceState(state, {
    type: 'turn_diff_updated',
    payload: { threadId: 'thread-2', diff: 'diff --git a/file' },
  });

  state = reduceState(state, {
    type: 'composer_text_changed',
    payload: { text: 'continue' },
  });

  state = reduceState(state, {
    type: 'system_status_loaded',
    payload: {
      overall: 'connected',
      backend: { status: 'connected' },
      relay: { status: 'online' },
      lastError: null,
    },
  });

  state = reduceState(state, {
    type: 'project_panel_toggled',
  });

  state = reduceState(state, {
    type: 'activity_panel_toggled',
  });

  state = reduceState(state, {
    type: 'panel_preference_changed',
    payload: { enabled: true },
  });

  state = reduceState(state, {
    type: 'project_panel_resized',
    payload: { width: 412 },
  });

  state = reduceState(state, {
    type: 'activity_panel_resized',
    payload: { width: 286 },
  });

  state = reduceState(state, {
    type: 'conversation_nav_visibility_toggled',
  });

  state = reduceState(state, {
    type: 'mobile_drawer_opened',
    payload: { mode: 'activity' },
  });

  state = reduceState(state, {
    type: 'mobile_drawer_mode_changed',
    payload: { mode: 'sessions' },
  });

  state = reduceState(state, {
    type: 'mobile_drawer_closed',
  });

  state = reduceState(state, {
    type: 'project_session_drafted',
    payload: { projectId: '/tmp/workspace-a' },
  });

  assert.equal(state.projects[0].collapsed, false);
  assert.equal(state.historyDialogProjectId, null);
  assert.equal(state.historyDialogTab, 'active');
  assert.equal(state.selectedSessionId, null);
  assert.equal(state.pendingSessionProjectId, '/tmp/workspace-a');
  assert.match(state.diffBySession['thread-2'], /diff --git/);
  assert.equal(state.systemStatus.backend.status, 'connected');
  assert.equal(state.composerDraft, 'continue');
  assert.equal(state.projectPanelCollapsed, true);
  assert.equal(state.activityPanelCollapsed, false);
  assert.equal(state.persistPanelPreference, true);
  assert.equal(state.projectPanelWidth, 412);
  assert.equal(state.activityPanelWidth, 286);
  assert.equal(state.showConversationNav, false);
  assert.equal(state.mobileDrawerOpen, false);
  assert.equal(state.mobileDrawerMode, 'sessions');
});

test('ui reducer defaults to a collapsed activity panel', () => {
  const state = reduceState(undefined, { type: '__noop__' });

  assert.equal(state.projectPanelCollapsed, false);
  assert.equal(state.activityPanelCollapsed, true);
  assert.equal(state.approvalMode, 'auto-approve');
});

test('ui reducer stores composer attachments and clears them when switching sessions', () => {
  let state = reduceState(undefined, {
    type: 'composer_attachments_added',
    payload: {
      attachments: [
        {
          id: 'draft-1',
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
          preview: { kind: 'image', url: 'data:image/png;base64,Zm9v' },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'composer_attachment_error_changed',
    payload: { error: 'Codex 不支持附件“report.pdf”（application/pdf）。' },
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-1' },
  });

  assert.deepEqual(state.composerAttachments, []);
  assert.equal(state.composerAttachmentError, null);
});

test('ui reducer syncs session titles into the project tree and tracks unread background updates', () => {
  let state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
      projects: [
        {
          id: '/tmp/workspace-a',
          cwd: '/tmp/workspace-a',
          displayName: 'workspace-a',
          collapsed: false,
          focusedSessions: [
            { id: 'thread-1', name: 'Selected thread', preview: 'opened', updatedAt: 5 },
            { id: 'thread-2', name: 'Old background name', preview: 'stale', updatedAt: 4 },
          ],
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
    type: 'turn_started',
    payload: { threadId: 'thread-2', turnId: 'turn-2' },
  });

  state = reduceState(state, {
    type: 'session_detail_loaded',
    payload: {
      thread: {
        id: 'thread-2',
        name: 'Renamed background thread',
        preview: 'fresh preview',
        cwd: '/tmp/workspace-a',
        turns: [],
      },
    },
  });

  assert.equal(state.projects[0].focusedSessions[1].name, 'Renamed background thread');
  assert.equal(state.projects[0].focusedSessions[1].preview, 'fresh preview');
  assert.equal(state.unreadBySession['thread-2'], 1);

  state = reduceState(state, {
    type: 'thread_name_updated',
    payload: { threadId: 'thread-1', name: 'Renamed selected thread' },
  });

  assert.equal(state.projects[0].focusedSessions[0].name, 'Renamed selected thread');

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-2' },
  });

  assert.equal(state.unreadBySession['thread-2'], 0);
});

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

test('ui reducer clears subagent dialog selection when switching sessions', () => {
  let state = reduceState(undefined, {
    type: 'subagent_dialog_opened',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'item-collab-1',
    },
  });

  assert.deepEqual(state.subagentDialog, {
    threadId: 'thread-1',
    turnId: 'turn-2',
    itemId: 'item-collab-1',
  });

  state = reduceState(state, {
    type: 'session_selected',
    payload: { id: 'thread-2' },
  });

  assert.equal(state.subagentDialog, null);
});

test('ui reducer stores structured task plans from turn plan updates', () => {
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
    type: 'session_detail_loaded',
    payload: {
      thread: {
        id: 'thread-1',
        name: 'Focus thread',
        cwd: '/tmp/workspace-a',
        turns: [
          {
            id: 'turn-2',
            status: 'started',
            items: [],
          },
        ],
      },
    },
  });

  state = reduceState(state, {
    type: 'turn_plan_updated',
    payload: {
      threadId: 'thread-1',
      turnId: 'turn-2',
      explanation: '先补协议再补 UI',
      plan: [
        { step: '对接结构化任务事件', status: 'completed' },
        { step: '右栏拆成活动和任务', status: 'inProgress' },
        { step: '补样式和回归测试', status: 'pending' },
      ],
    },
  });

  const thread = state.sessionDetailsById['thread-1'];
  assert.equal(thread.turns[0].plan.explanation, '先补协议再补 UI');
  assert.deepEqual(thread.turns[0].plan.steps, [
    { step: '对接结构化任务事件', status: 'completed' },
    { step: '右栏拆成活动和任务', status: 'inProgress' },
    { step: '补样式和回归测试', status: 'pending' },
  ]);
});

test('ui reducer stores per-session realtime state from streaming notifications', () => {
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
    type: 'thread_realtime_started',
    payload: { threadId: 'thread-1', sessionId: 'rt-session-1' },
  });

  state = reduceState(state, {
    type: 'thread_realtime_item_added',
    payload: {
      threadId: 'thread-1',
      item: { type: 'response.output_text.delta', text: 'hello world' },
    },
  });

  state = reduceState(state, {
    type: 'thread_realtime_audio_delta',
    payload: {
      threadId: 'thread-1',
      audio: {
        data: 'AAA=',
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 480,
      },
    },
  });

  state = reduceState(state, {
    type: 'thread_realtime_error',
    payload: { threadId: 'thread-1', message: 'stream failed' },
  });

  state = reduceState(state, {
    type: 'thread_realtime_closed',
    payload: { threadId: 'thread-1', reason: 'completed' },
  });

  assert.deepEqual(state.realtimeBySession['thread-1'], {
    status: 'closed',
    sessionId: 'rt-session-1',
    items: [
      {
        index: 1,
        summary: 'response.output_text.delta',
        value: { type: 'response.output_text.delta', text: 'hello world' },
      },
    ],
    audioChunkCount: 1,
    audioByteCount: 4,
    lastAudio: {
      sampleRate: 24000,
      numChannels: 1,
      samplesPerChannel: 480,
    },
    lastError: 'stream failed',
    closeReason: 'completed',
  });
});

test('render helpers show focused session titles by default and reveal history in dialog tabs', () => {
  const sessionCwd = '/tmp/workspace-a';
  const systemStatus = {
    overall: 'connected',
    backend: { status: 'connected' },
    relay: { status: 'online' },
    lastError: null,
  };
  const sidebarHtml = renderProjectSidebar({
    systemStatus,
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [
          {
            id: 'thread-1',
            name: 'Focus thread',
            preview: 'active thread',
            cwd: sessionCwd,
            updatedAt: 5,
          },
        ],
        historySessions: {
          active: [{ id: 'thread-3', name: 'Working thread', updatedAt: 4 }],
          archived: [{ id: 'thread-2', name: 'Archived task', updatedAt: 3 }],
        },
      },
    ],
    historyDialogProjectId: null,
    selectedSessionId: 'thread-1',
  });

  const dialogHtml = renderHistoryDialog({
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [
          { id: 'thread-1', name: 'Focus thread', preview: 'active thread', updatedAt: 5 },
        ],
        historySessions: {
          active: [{ id: 'thread-3', name: 'Working thread', updatedAt: 4 }],
          archived: [{ id: 'thread-2', name: 'Archived task', updatedAt: 3 }],
        },
      },
    ],
    historyDialogProjectId: '/tmp/workspace-a',
    historyDialogTab: 'active',
    persistPanelPreference: true,
    selectedSessionId: 'thread-2',
  });

  const archivedDialogHtml = renderHistoryDialog({
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [
          { id: 'thread-1', name: 'Focus thread', preview: 'active thread', updatedAt: 5 },
        ],
        historySessions: {
          active: [{ id: 'thread-3', name: 'Working thread', updatedAt: 4 }],
          archived: [{ id: 'thread-2', name: 'Archived task', updatedAt: 3 }],
        },
      },
    ],
    historyDialogProjectId: '/tmp/workspace-a',
    historyDialogTab: 'archived',
    persistPanelPreference: false,
    selectedSessionId: 'thread-2',
  });

  const emptyDetailHtml = renderThreadDetail(null, null, systemStatus);
  const detailHtml = renderThreadDetail(
    {
      id: 'thread-2',
      name: 'Archived task',
      preview: 'archived thread',
      cwd: sessionCwd,
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item-1',
              content: [{ type: 'text', text: 'Say hello\n', text_elements: [] }],
            },
            {
              type: 'agentMessage',
              id: 'item-2',
              text: 'Agent reply',
              phase: 'final_answer',
            },
          ],
        },
      ],
    },
    null,
    systemStatus,
  );

  assert.match(sidebarHtml, /workspace-a/);
  assert.match(sidebarHtml, /添加项目/);
  assert.doesNotMatch(sidebarHtml, /后端正常/);
  assert.match(sidebarHtml, /<h2>项目\/会话<\/h2>/);
  assert.doesNotMatch(sidebarHtml, /<h2>项目<\/h2>/);
  assert.doesNotMatch(sidebarHtml, /默认只显示本应用关注的会话。历史会话可按项目临时导入。/);
  assert.match(sidebarHtml, /Focus thread/);
  assert.doesNotMatch(sidebarHtml, /active thread/);
  assert.doesNotMatch(sidebarHtml, /session-item-subtitle/);
  assert.match(sidebarHtml, /project-action-group/);
  assert.match(sidebarHtml, /project-action--primary/);
  assert.match(sidebarHtml, /project-action--secondary/);
  assert.match(sidebarHtml, /aria-label="新会话"/);
  assert.match(sidebarHtml, /aria-label="添加历史会话"/);
  assert.doesNotMatch(sidebarHtml, />新会话</);
  assert.doesNotMatch(sidebarHtml, />添加历史会话</);
  assert.doesNotMatch(sidebarHtml, /session-item-chip/);
  assert.doesNotMatch(sidebarHtml, /session-item-accent/);
  assert.doesNotMatch(sidebarHtml, /↗/);
  assert.doesNotMatch(emptyDetailHtml, /后端正常/);
  assert.doesNotMatch(detailHtml, /后端正常/);
  assert.doesNotMatch(emptyDetailHtml, /thread-empty-title/);
  assert.doesNotMatch(detailHtml, /thread-header-title/);
  assert.doesNotMatch(emptyDetailHtml, /thread-status-dot/);
  assert.doesNotMatch(detailHtml, /thread-status-dot/);
  assert.doesNotMatch(sidebarHtml, /Archived task/);
  assert.doesNotMatch(sidebarHtml, /未归档/);
  assert.match(dialogHtml, /dialog/);
  assert.match(dialogHtml, /添加历史会话/);
  assert.match(dialogHtml, /未归档/);
  assert.match(dialogHtml, /已归档/);
  assert.doesNotMatch(dialogHtml, /记住侧栏开关状态/);
  assert.doesNotMatch(dialogHtml, /data-panel-preference-toggle/);
  assert.match(dialogHtml, /Working thread/);
  assert.match(dialogHtml, /session-item-subtitle/);
  assert.doesNotMatch(dialogHtml, /Archived task/);
  assert.match(archivedDialogHtml, /Archived task/);
  assert.doesNotMatch(archivedDialogHtml, /Working thread/);
  assert.match(emptyDetailHtml, /会话详情/);
  assert.match(detailHtml, /重命名/);
  assert.doesNotMatch(detailHtml, /上一回合/);
  assert.doesNotMatch(detailHtml, /下一回合/);
  assert.doesNotMatch(detailHtml, /到底部/);
  assert.match(detailHtml, /Say hello/);
  assert.match(detailHtml, /Agent reply/);
});

test('render helpers can limit thread detail rendering to a turn window while keeping absolute turn numbers', () => {
  const detailHtml = renderThreadDetail(
    {
      id: 'thread-windowed',
      name: 'Large thread',
      cwd: '/tmp/workspace-a',
      turns: Array.from({ length: 6 }, (_, index) => ({
        id: `turn-${index + 1}`,
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: `item-${index + 1}`,
            text: `Message ${index + 1}`,
          },
        ],
      })),
    },
    null,
    null,
    null,
    { startTurnIndex: 3, endTurnIndex: 5, totalTurns: 6 },
  );

  assert.match(detailHtml, /Turn 4/);
  assert.match(detailHtml, /Turn 6/);
  assert.doesNotMatch(detailHtml, /Turn 1/);
  assert.match(detailHtml, /上方还有 3 个回合/);
});

test('render helpers show discovered external Claude session badges in the sidebar and detail header', () => {
  const systemStatus = {
    overall: 'connected',
    backend: { status: 'connected' },
    relay: { status: 'online' },
    lastError: null,
  };
  const externalSession = {
    id: 'thread-external',
    name: 'External Claude session',
    preview: 'Continue the rollout',
    cwd: '/tmp/workspace-a',
    updatedAt: 123,
    createdAt: 120,
    status: { type: 'loaded' },
    external: {
      bridgeMode: 'discovered',
      runtimeSource: 'claude-discovered',
    },
    turns: [],
  };
  const sidebarHtml = renderProjectSidebar({
    systemStatus,
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [externalSession],
        historySessions: {
          active: [],
          archived: [],
        },
      },
    ],
    selectedSessionId: 'thread-external',
    pendingSessionProjectId: null,
    loadError: null,
    auth: { authenticated: false },
  });
  const detailHtml = renderThreadDetail(externalSession, null, systemStatus);

  assert.match(sidebarHtml, /session-external-badge/);
  assert.match(sidebarHtml, />已发现</);
  assert.match(detailHtml, /meta-chip--external/);
  assert.match(detailHtml, />已发现</);
});

test('render helpers show active external Claude sessions with a live badge and approval cards', () => {
  const systemStatus = {
    overall: 'connected',
    backend: { status: 'connected' },
    relay: { status: 'online' },
    lastError: null,
  };
  const externalSession = {
    id: 'thread-external-live',
    name: 'External Claude session',
    preview: 'Waiting for approval',
    cwd: '/tmp/workspace-a',
    updatedAt: 123,
    createdAt: 120,
    status: { type: 'loaded' },
    external: {
      bridgeMode: 'hooked+tail',
      runtimeSource: 'claude-external-bridge',
    },
    runtime: {
      source: 'claude-hook',
      turnStatus: 'started',
      activeTurnId: 'external-turn-live',
      realtime: {
        status: 'started',
        sessionId: 'external-session-live',
        items: [],
        audioChunkCount: 0,
        audioByteCount: 0,
        lastAudio: null,
        lastError: null,
        closeReason: null,
      },
    },
    pendingApprovals: [
      {
        id: 'approval-live',
        threadId: 'thread-external-live',
        kind: 'Bash',
        summary: 'Allow Bash usage',
        detail: {
          toolName: 'Bash',
        },
        status: 'pending',
      },
    ],
    pendingApprovalCount: 1,
    turns: [],
  };
  const sidebarHtml = renderProjectSidebar({
    systemStatus,
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [externalSession],
        historySessions: {
          active: [],
          archived: [],
        },
      },
    ],
    selectedSessionId: 'thread-external-live',
    pendingSessionProjectId: null,
    loadError: null,
    auth: { authenticated: false },
  });
  const detailHtml = renderThreadDetail(
    externalSession,
    null,
    systemStatus,
    { pendingApprovalIds: new Set(), error: null },
  );

  assert.match(sidebarHtml, /外部运行中/);
  assert.match(detailHtml, /外部运行中/);
  assert.match(detailHtml, /待处理审批/);
  assert.match(detailHtml, /Allow Bash usage/);
});

test('render helpers show swipe actions plus busy and unread indicators in focused sessions', () => {
  const sidebarHtml = renderProjectSidebar({
    systemStatus: {
      overall: 'connected',
      backend: { status: 'connected' },
      relay: { status: 'online' },
      lastError: null,
    },
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [
          { id: 'thread-1', name: 'Idle thread', preview: 'read', updatedAt: 9 },
          { id: 'thread-2', name: 'Running thread', preview: 'working', updatedAt: 8 },
          { id: 'thread-3', name: 'Unread thread', preview: 'new reply', updatedAt: 7 },
        ],
        historySessions: {
          active: [],
          archived: [],
        },
      },
    ],
    selectedSessionId: 'thread-1',
    turnStatusBySession: {
      'thread-2': 'started',
      'thread-3': 'completed',
    },
    unreadBySession: {
      'thread-3': 2,
    },
  });

  assert.match(sidebarHtml, /session-swipe-lane/);
  assert.match(sidebarHtml, /data-project-close="\/tmp\/workspace-a"/);
  assert.match(sidebarHtml, /focus-remove focus-remove--embedded/);
  assert.match(sidebarHtml, /session-status-indicator--busy/);
  assert.match(sidebarHtml, /session-status-indicator--unread/);
});

test('render helpers show streaming agent output and subagent jump entries in the thread header', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-2',
    name: 'Streaming session',
    preview: 'archived thread',
    cwd: '/tmp/workspace-a',
    turns: [
      {
        id: 'turn-1',
        status: 'started',
        items: [
          {
            type: 'userMessage',
            id: 'item-1',
            content: [{ type: 'text', text: 'Inspect the layout', text_elements: [] }],
          },
          {
            type: 'agentMessage',
            id: 'item-2',
            text: 'Streaming token by token',
            phase: 'commentary',
            streaming: true,
          },
          {
            type: 'collabAgentToolCall',
            id: 'item-collab-1',
            tool: 'spawnAgent',
            status: 'inProgress',
            senderThreadId: 'thread-2',
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
        ],
      },
    ],
  });

  assert.match(detailHtml, /Subagents/);
  assert.match(detailHtml, /agent-thread-1/);
  assert.match(detailHtml, /运行中/);
  assert.match(detailHtml, /跳转/);
  assert.match(detailHtml, /data-subagent-turn-index="0"/);
  assert.match(detailHtml, /message-bubble--streaming/);
});

test('render helpers show realtime session details ahead of the turn list', () => {
  const detailHtml = renderThreadDetail(
    {
      id: 'thread-realtime',
      name: 'Realtime session',
      cwd: '/tmp/workspace-a',
      turns: [],
    },
    {
      status: 'closed',
      sessionId: 'rt-session-1',
      items: [
        {
          index: 1,
          summary: 'response.created',
          value: { type: 'response.created', response: { id: 'resp-1' } },
        },
      ],
      audioChunkCount: 2,
      audioByteCount: 8,
      lastAudio: {
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 480,
      },
      lastError: 'stream failed',
      closeReason: 'completed',
    },
  );

  assert.match(detailHtml, /实时/);
  assert.match(detailHtml, /rt-session-1/);
  assert.match(detailHtml, /response\.created/);
  assert.match(detailHtml, /音频/);
  assert.match(detailHtml, /24000 Hz/);
  assert.match(detailHtml, /stream failed/);
  assert.match(detailHtml, /completed/);
});

test('render helpers show pending approval cards in the selected session detail', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-approval',
    name: 'Approval thread',
    cwd: '/tmp/workspace-a',
    pendingApprovalCount: 1,
    waitingOnApproval: true,
    pendingApprovals: [
      {
        id: 'approval-1',
        kind: 'commandExecution',
        summary: 'Run npm test',
        detail: {
          command: 'npm test',
          cwd: '/tmp/workspace-a',
        },
        status: 'pending',
      },
    ],
    turns: [],
  });

  assert.match(detailHtml, /待处理审批/);
  assert.match(detailHtml, /Run npm test/);
  assert.match(detailHtml, /npm test/);
  assert.match(detailHtml, /批准/);
  assert.match(detailHtml, /拒绝/);
});

test('render helpers show pending question cards in the selected session detail', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-question',
    name: 'Question thread',
    cwd: '/tmp/workspace-a',
    pendingQuestionCount: 1,
    pendingQuestions: [
      {
        id: 'question-1',
        kind: 'ask_user_question',
        summary: '需要用户回答',
        prompt: '请选择下一步',
        questions: [{ question: '继续执行吗？' }],
        status: 'pending',
      },
    ],
    turns: [],
  });

  assert.match(detailHtml, /待处理问题/);
  assert.match(detailHtml, /需要用户回答/);
  assert.match(detailHtml, /继续执行吗？/);
  assert.match(detailHtml, /data-pending-action-input="question-1"/);
  assert.match(detailHtml, /data-pending-action-submit="question-1"/);
});

test('ui reducer tracks pending question updates in project and detail state', () => {
  const questionOne = {
    id: 'question-1',
    threadId: 'thread-1',
    kind: 'ask_user_question',
    summary: '需要用户回答',
    prompt: '请选择下一步',
    questions: [{ question: '继续执行吗？' }],
    status: 'pending',
  };
  const questionTwo = {
    id: 'question-2',
    threadId: 'thread-1',
    kind: 'ask_user_question',
    summary: '二次确认',
    prompt: '是否应用变更？',
    questions: [{ question: '是否应用变更？' }],
    status: 'pending',
  };

  let state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
      projects: [
        {
          id: '/tmp/workspace-a',
          cwd: '/tmp/workspace-a',
          displayName: 'workspace-a',
          collapsed: false,
          focusedSessions: [
            {
              id: 'thread-1',
              name: 'Question thread',
              pendingQuestionCount: 1,
              pendingQuestions: [questionOne],
            },
          ],
          historySessions: {
            active: [],
            archived: [],
          },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'session_detail_loaded',
    payload: {
      thread: {
        id: 'thread-1',
        name: 'Question thread',
        cwd: '/tmp/workspace-a',
        pendingQuestionCount: 1,
        pendingQuestions: [questionOne],
        turns: [],
      },
    },
  });

  state = reduceState(state, {
    type: 'pending_question_requested',
    payload: {
      question: questionTwo,
    },
  });

  state = reduceState(state, {
    type: 'pending_question_resolved',
    payload: {
      question: {
        ...questionOne,
        status: 'answered',
      },
    },
  });

  assert.equal(state.projects[0].focusedSessions[0].pendingQuestionCount, 1);
  assert.equal(state.projects[0].focusedSessions[0].pendingQuestions[0].id, 'question-2');
  assert.equal(state.sessionDetailsById['thread-1'].pendingQuestionCount, 1);
  assert.equal(state.sessionDetailsById['thread-1'].pendingQuestions[0].id, 'question-2');
});

test('ui reducer tracks approval mode and live approval updates in project and detail state', () => {
  const approvalOne = {
    id: 'approval-1',
    threadId: 'thread-1',
    kind: 'commandExecution',
    summary: 'Run npm test',
    detail: { command: 'npm test', cwd: '/tmp/workspace-a' },
    status: 'pending',
  };
  const approvalTwo = {
    id: 'approval-2',
    threadId: 'thread-1',
    kind: 'fileChange',
    summary: 'Review src/app.js',
    detail: { path: 'src/app.js' },
    status: 'pending',
  };

  let state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
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
              pendingApprovalCount: 1,
              waitingOnApproval: true,
              pendingApprovals: [approvalOne],
            },
          ],
          historySessions: {
            active: [],
            archived: [],
          },
        },
      ],
    },
  });

  state = reduceState(state, {
    type: 'approval_mode_loaded',
    payload: { mode: 'auto-approve' },
  });

  state = reduceState(state, {
    type: 'session_detail_loaded',
    payload: {
      thread: {
        id: 'thread-1',
        name: 'Approval thread',
        cwd: '/tmp/workspace-a',
        pendingApprovalCount: 1,
        waitingOnApproval: true,
        pendingApprovals: [approvalOne],
        turns: [],
      },
    },
  });

  state = reduceState(state, {
    type: 'approval_requested',
    payload: {
      approval: approvalTwo,
    },
  });

  state = reduceState(state, {
    type: 'approval_resolved',
    payload: {
      approval: {
        ...approvalOne,
        status: 'approved',
      },
    },
  });

  const sidebarHtml = renderProjectSidebar({
    ...state,
    systemStatus: {
      overall: 'connected',
      backend: { status: 'connected' },
      relay: { status: 'online' },
      lastError: null,
    },
    selectedSessionId: 'thread-9',
  });

  assert.equal(state.approvalMode, 'auto-approve');
  assert.equal(state.projects[0].focusedSessions[0].pendingApprovalCount, 1);
  assert.equal(state.projects[0].focusedSessions[0].pendingApprovals[0].id, 'approval-2');
  assert.equal(state.sessionDetailsById['thread-1'].pendingApprovalCount, 1);
  assert.equal(state.sessionDetailsById['thread-1'].pendingApprovals[0].id, 'approval-2');
  assert.match(sidebarHtml, /session-status-indicator--approval/);
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

test('render helpers show native cards for reasoning command mcp and unknown items', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-2',
    name: 'Structured session',
    cwd: '/tmp/workspace-a',
    turns: [
      {
        id: 'turn-1',
        status: 'started',
        items: [
          {
            type: 'reasoning',
            id: 'item-reasoning-1',
            summary: ['Checking repo shape'],
            content: ['Scanning files'],
          },
          {
            type: 'commandExecution',
            id: 'item-command-1',
            command: 'npm test',
            cwd: '/tmp/workspace-a',
            processId: '123',
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: 'stdout line 1\n',
            exitCode: null,
            durationMs: null,
          },
          {
            type: 'mcpToolCall',
            id: 'item-mcp-1',
            server: 'openaiDeveloperDocs',
            tool: 'search_openai_docs',
            status: 'inProgress',
            arguments: { q: 'streaming ui' },
            result: null,
            error: null,
            durationMs: null,
            progressMessages: ['Searching docs'],
          },
          {
            type: 'contextCompaction',
            id: 'item-fallback-1',
          },
        ],
      },
    ],
  });

  assert.match(detailHtml, /thread-item-card/);
  assert.match(detailHtml, /推理/);
  assert.match(detailHtml, /Checking repo shape/);
  assert.match(detailHtml, /命令执行/);
  assert.match(detailHtml, /npm test/);
  assert.match(detailHtml, /thread-item-card--collapsible/);
  assert.match(detailHtml, /thread-item-card-summary/);
  assert.doesNotMatch(detailHtml, /thread-item-card--command thread-item-card--collapsible\" open/);
  assert.match(detailHtml, /stdout line 1/);
  assert.match(detailHtml, /MCP 工具/);
  assert.match(detailHtml, /thread-item-card--mcp thread-item-card--collapsible/);
  assert.doesNotMatch(detailHtml, /thread-item-card--mcp thread-item-card--collapsible\" open/);
  assert.match(detailHtml, /thread-item-card-summary-meta/);
  assert.match(detailHtml, /thread-item-card-toggle-label/);
  assert.match(detailHtml, /openaiDeveloperDocs/);
  assert.match(detailHtml, /search_openai_docs/);
  assert.match(detailHtml, /streaming ui/);
  assert.match(detailHtml, /Searching docs/);
  assert.match(detailHtml, /通用事件/);
  assert.match(detailHtml, /contextCompaction/);
});

test('render helpers separate command status chips from disclosure controls and collapse file changes by default', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-commands',
    name: 'Command session',
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
            status: 'failed',
            aggregatedOutput: 'stderr line 1\n',
          },
          {
            type: 'fileChange',
            id: 'item-file-1',
            path: 'src/app.js',
            changeType: 'modified',
            diff: '@@ -1 +1 @@\n-console.log("old")\n+console.log("new")\n',
          },
        ],
      },
    ],
  });

  assert.match(detailHtml, /thread-item-card-summary-meta/);
  assert.match(detailHtml, /thread-item-card-status thread-item-card-status--failed/);
  assert.match(detailHtml, /thread-item-card-toggle-label/);
  assert.match(detailHtml, /thread-item-card-toggle-icon/);
  assert.match(detailHtml, /命令执行/);
  assert.match(detailHtml, /stderr line 1/);
  assert.match(detailHtml, /文件变更/);
  assert.match(detailHtml, /src\/app\.js/);
  assert.match(detailHtml, /thread-item-card--fileChange thread-item-card--collapsible/);
  assert.doesNotMatch(detailHtml, /thread-item-card--fileChange thread-item-card--collapsible\" open/);
});

test('render helpers fall back to the session id when title fields are empty', () => {
  const sidebarHtml = renderProjectSidebar({
    systemStatus: {
      overall: 'connected',
      backend: { status: 'connected' },
      relay: { status: 'online' },
      lastError: null,
    },
    projects: [
      {
        id: '/tmp/workspace-a',
        cwd: '/tmp/workspace-a',
        displayName: 'workspace-a',
        collapsed: false,
        focusedSessions: [{ id: 'thread-empty', name: null, preview: '', updatedAt: 5 }],
        historySessions: {
          active: [],
          archived: [],
        },
      },
    ],
    historyDialogProjectId: null,
    selectedSessionId: 'thread-empty',
  });

  assert.match(sidebarHtml, /<span class="session-title">thread-empty<\/span>/);
});

test('render helpers render full markdown in message bubbles and keep raw html escaped', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-markdown',
    name: 'Markdown session',
    cwd: '/tmp/workspace-a',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'item-markdown-1',
            phase: 'final_answer',
            text: [
              '# Heading',
              '',
              '- first item',
              '- second item',
              '',
              '1. ordered one',
              '2. ordered two',
              '',
              '> quoted line',
              '',
              'Use `inline code` here.',
              '',
              '```js',
              'const value = 1;',
              '```',
              '',
              '| Name | Value |',
              '| --- | --- |',
              '| alpha | 1 |',
              '',
              '[Example](https://example.com)',
              '',
              '<script>alert("xss")</script>',
            ].join('\n'),
          },
        ],
      },
    ],
  });

  assert.match(detailHtml, /message-markdown/);
  assert.match(detailHtml, /<h1[^>]*>Heading<\/h1>/);
  assert.match(detailHtml, /<ul>\s*<li>first item<\/li>\s*<li>second item<\/li>\s*<\/ul>/);
  assert.match(detailHtml, /<ol>\s*<li>ordered one<\/li>\s*<li>ordered two<\/li>\s*<\/ol>/);
  assert.match(detailHtml, /<blockquote>\s*<p>quoted line<\/p>\s*<\/blockquote>/);
  assert.match(detailHtml, /<code>inline code<\/code>/);
  assert.match(detailHtml, /<pre><code class="language-js">const value = 1;\n<\/code><\/pre>/);
  assert.match(detailHtml, /<table>/);
  assert.match(detailHtml, /<a[^>]+href="https:\/\/example\.com"/);
  assert.match(detailHtml, /<a[^>]+target="_blank"/);
  assert.match(detailHtml, /<a[^>]+rel="noreferrer noopener"/);
  assert.match(detailHtml, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(detailHtml, /<script>alert\("xss"\)<\/script>/);
});

test('render helpers show a disconnected status light and error message when the backend is unavailable', () => {
  const sidebarHtml = renderProjectSidebar({
    systemStatus: {
      overall: 'disconnected',
      backend: { status: 'disconnected' },
      relay: { status: 'online' },
      lastError: 'WebSocket is not open: readyState 3 (CLOSED)',
    },
    projects: [],
    selectedSessionId: null,
    loadError: 'WebSocket is not open: readyState 3 (CLOSED)',
  });

  assert.match(sidebarHtml, /后端断开/);
  assert.match(sidebarHtml, /WebSocket is not open/);
});

test('conversation turn navigation targets the nearest previous and next rounds', () => {
  const turnOffsets = [120, 360, 720];

  assert.equal(findConversationTurnTarget(turnOffsets, 40, 'next'), 120);
  assert.equal(findConversationTurnTarget(turnOffsets, 120, 'next'), 360);
  assert.equal(findConversationTurnTarget(turnOffsets, 520, 'next'), 720);
  assert.equal(findConversationTurnTarget(turnOffsets, 760, 'next'), 720);

  assert.equal(findConversationTurnTarget(turnOffsets, 760, 'previous'), 720);
  assert.equal(findConversationTurnTarget(turnOffsets, 520, 'previous'), 360);
  assert.equal(findConversationTurnTarget(turnOffsets, 120, 'previous'), 120);
  assert.equal(findConversationTurnTarget(turnOffsets, 20, 'previous'), 120);
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
  assert.equal(fakeDocument.sendButton.textContent, '停止');
  assert.equal(fakeDocument.sendButton.disabled, false);
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'started');
  assert.equal(fakeDocument.interruptButton.hidden, true);
  await app.interruptTurn();
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'interrupting');
  assert.equal(fakeDocument.sendButton.textContent, '停止中…');
  assert.equal(fakeDocument.sendButton.disabled, true);
  fakeEventSource.emit({
    type: 'turn_completed',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
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
  assert.equal(app.getState().turnStatusBySession['thread-1'], 'completed');
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

test('browser app loads session option catalogs, restores per-session settings, and disables controls for running sessions', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const settingsByThread = {
    'thread-1': { model: 'gpt-5.4', reasoningEffort: null, sandboxMode: 'workspace-write' },
    'thread-2': { model: null, reasoningEffort: 'high', sandboxMode: 'read-only' },
  };

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
                  name: 'Model thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
                {
                  id: 'thread-2',
                  name: 'Running thread',
                  runtime: {
                    turnStatus: 'started',
                    activeTurnId: 'turn-2',
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
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
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [
            { value: '', label: '默认' },
            { value: 'gpt-5.4', label: 'gpt-5.4' },
          ],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'high', label: '高' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            sandboxMode: 'danger-full-access',
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse(settingsByThread['thread-1']);
      }

      if (url === '/api/sessions/thread-2/settings') {
        return jsonResponse(settingsByThread['thread-2']);
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Model thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-2',
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /<span class="approval-mode-label">/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="" selected>默认<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="gpt-5\.4" selected>gpt-5\.4<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="workspace-write" selected>工作区可写<\/option>/);
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: 'gpt-5.4',
    reasoningEffort: null,
    sandboxMode: 'workspace-write',
  });

  await app.selectSession('thread-2');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="high" selected>高<\/option>/);
  assert.deepEqual(app.getState().sessionSettingsById['thread-2'], {
    model: null,
    reasoningEffort: 'high',
    sandboxMode: 'read-only',
  });
});

test('browser app renders a compact composer task-summary band with expanded plan details and a placeholder fallback', async () => {
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
              focusedSessions: [
                {
                  id: 'thread-1',
                  name: 'Planned thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
                {
                  id: 'thread-2',
                  name: 'No-plan thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
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
            name: 'Planned thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [
              {
                id: 'turn-0',
                status: 'completed',
                items: [
                  {
                    type: 'plan',
                    explanation: '这是更早的计划，不应该驱动摘要带。',
                    plan: [
                      { step: '旧计划：只验证旧入口', status: 'completed' },
                      { step: '旧计划：不会显示在新摘要', status: 'pending' },
                    ],
                  },
                ],
              },
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'plan',
                    explanation: '先收敛范围，再推进实现。',
                    plan: [
                      { step: '整理现有会话状态入口', status: 'completed' },
                      { step: '补齐紧凑摘要文案', status: 'completed' },
                      { step: '接入运行态动作语义', status: 'inProgress' },
                      { step: '收敛附件入口层级', status: 'pending' },
                      { step: '完成移动端折叠态', status: 'pending' },
                      { step: '回归验证', status: 'pending' },
                    ],
                  },
                ],
              },
              {
                id: 'turn-2',
                status: 'completed',
                items: [
                  {
                    type: 'agentMessage',
                    text: '后续回复没有新的计划更新。',
                  },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'No-plan thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [{ id: 'turn-2', status: 'completed', items: [] }],
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

  assert.match(fakeDocument.composer.innerHTML, /已完成 2 个任务（共 6 个）/);
  assert.match(fakeDocument.composer.innerHTML, /data-task-summary-breakdown="true"/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /旧计划：只验证旧入口/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /旧计划：不会显示在新摘要/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /后续回复没有新的计划更新/);

  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'completed', '整理现有会话状态入口');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'completed', '补齐紧凑摘要文案');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'running', '接入运行态动作语义');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'upcoming', '收敛附件入口层级');
  assertTaskSummaryItem(fakeDocument.composer.innerHTML, 'upcoming', '完成移动端折叠态');

  await app.selectSession('thread-2');

  assert.match(fakeDocument.composer.innerHTML, /暂无任务计划/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /activity-card/);
});

test('browser app applies the new composer action hierarchy and surfaces blocked feedback inline', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const requests = [];
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method ?? 'GET',
      });

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
                  name: 'Busy thread',
                  waitingOnApproval: true,
                  pendingApprovalCount: 1,
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
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
            name: 'Busy thread',
            cwd: '/tmp/workspace-a',
            waitingOnApproval: true,
            pendingApprovalCount: 1,
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/interrupt') {
        return jsonResponse({ interrupted: true }, 202);
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

      if (url === '/api/turn' && options.method === 'POST') {
        return jsonResponse({
          threadId: 'thread-1',
          turn: { id: 'turn-2', status: 'started', items: [] },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  const attachmentTriggerMatches = [
    ...fakeDocument.composer.innerHTML.matchAll(/data-composer-attach-trigger="true"/g),
  ];
  assert.equal(attachmentTriggerMatches.length, 1);
  assert.equal(fakeDocument.composerUploadFileButton.hidden, false);
  assert.equal(fakeDocument.composerUploadImageButton.hidden, true);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  app.setComposerDraft('ready to run');
  fakeEventSource.emit({
    type: 'turn_started',
    payload: { threadId: 'thread-1', turnId: 'turn-2' },
  });
  assert.equal(fakeDocument.sendButton.dataset.action, 'interrupt');
  assert.match(fakeDocument.sendButton.textContent, /(中断|停止)/);

  fakeDocument.composer.dispatchEvent({
    type: 'submit',
    preventDefault() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.some((request) => request.url === '/api/sessions/thread-1/interrupt'), true);
  assert.equal(
    requests.some((request) => request.url === '/api/turn' && request.method === 'POST'),
    false,
  );
  assert.equal(fakeDocument.sendButton.dataset.action, 'interrupting');
  assert.match(fakeDocument.sendButton.textContent, /停止/);
  assert.match(fakeDocument.composer.innerHTML, /等待审批后可继续发送/);
});

test('browser app renders compact settings metadata, collapses the mobile settings strip by default, and keeps controls disabled while busy', async () => {
  const fakeDocument = createFakeDocument({ mobile: true });
  const sandboxModeFromSessionOptions = 'workspace-write';
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
                  name: 'Idle thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
                {
                  id: 'thread-2',
                  name: 'Running thread',
                  runtime: {
                    turnStatus: 'started',
                    activeTurnId: 'turn-9',
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
                },
              ],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [
            { value: '', label: '默认' },
            { value: 'gpt-5.4', label: 'gpt-5.4' },
          ],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'high', label: '高' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            sandboxMode: 'danger-full-access',
          },
          runtimeContext: {
            sandboxMode: sandboxModeFromSessionOptions,
          },
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({ model: 'gpt-5.4', reasoningEffort: 'high', sandboxMode: 'workspace-write' });
      }

      if (url === '/api/sessions/thread-2/settings') {
        return jsonResponse({ model: null, reasoningEffort: null, sandboxMode: 'read-only' });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Idle thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    type: 'plan',
                    explanation: '先做紧凑摘要，再落地细节。',
                    plan: [
                      { step: '梳理状态源', status: 'completed' },
                      { step: '渲染摘要带', status: 'completed' },
                      { step: '对齐中断语义', status: 'inProgress' },
                      { step: '补齐阻塞反馈', status: 'pending' },
                      { step: '合并附件入口', status: 'pending' },
                      { step: '移动端折叠验证', status: 'pending' },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }

      if (url === '/api/sessions/thread-2') {
        return jsonResponse({
          thread: {
            id: 'thread-2',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-9',
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
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
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.match(fakeDocument.composer.innerHTML, /已完成 2 个任务（共 6 个）/);
  assert.match(fakeDocument.composer.innerHTML, /data-task-summary-collapsed="true"/);
  assert.doesNotMatch(fakeDocument.composer.innerHTML, /梳理状态源/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-toggle="true"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /composer-settings-mobile-summary-label/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="model"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="reasoning"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="sandbox"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="approval"/);

  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'model', '模型', 'gpt-5.4');
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'reasoning', '推理强度', '高');
  assertComposerSetting(
    fakeDocument.approvalModeControls.innerHTML,
    'sandbox',
    '沙箱隔离类型',
    '工作区可写',
  );
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'approval', '审批模式', '手动审批');
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /工作区可写/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /title="模型"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="模型：gpt-5\.4"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="沙箱隔离类型：工作区可写"/);

  app.toggleComposerSettings();
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="false"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-confirm="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, />确认<\/button>/);

  await app.selectSession('thread-2');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-approval-mode-select="true"[^>]*disabled/);
});

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

test('browser app saves session settings, reverts failures, and sends current turn settings', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const requests = [];
  let failNextSettingsSave = false;
  let savedSettings = { model: 'gpt-5.4', reasoningEffort: null, sandboxMode: 'danger-full-access' };

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
                  name: 'Model thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
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
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [
            { value: '', label: '默认' },
            { value: 'gpt-5.4', label: 'gpt-5.4' },
          ],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'medium', label: '中' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            sandboxMode: 'danger-full-access',
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings' && (!options.method || options.method === 'GET')) {
        return jsonResponse(savedSettings);
      }

      if (url === '/api/sessions/thread-1/settings' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        if (failNextSettingsSave) {
          failNextSettingsSave = false;
          return jsonErrorResponse({ error: 'settings failed' }, 500);
        }

        savedSettings = body;
        return jsonResponse(body);
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Model thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/turns') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        return jsonResponse({ turnId: 'turn-2', status: 'started' }, 202);
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const saveResult = await app.setSessionSettings('thread-1', {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });

  assert.deepEqual(saveResult, {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });

  failNextSettingsSave = true;
  const failedSave = await app.setSessionSettings('thread-1', {
    model: 'gpt-5.4',
    reasoningEffort: null,
    sandboxMode: 'read-only',
  });

  assert.equal(failedSave, null);
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
  });
  assert.match(fakeDocument.approvalModeControls.innerHTML, /settings failed/);

  app.setComposerDraft('continue');
  await app.sendTurn();

  assert.deepEqual(requests, [
    {
      url: '/api/sessions/thread-1/settings',
      method: 'POST',
      body: {
        model: null,
        reasoningEffort: 'medium',
        sandboxMode: 'workspace-write',
      },
    },
    {
      url: '/api/sessions/thread-1/settings',
      method: 'POST',
      body: {
        model: 'gpt-5.4',
        reasoningEffort: null,
        sandboxMode: 'read-only',
      },
    },
    {
      url: '/api/sessions/thread-1/turns',
      method: 'POST',
      body: {
        text: 'continue',
        model: null,
        reasoningEffort: 'medium',
        sandboxMode: 'workspace-write',
        attachments: [],
      },
    },
  ]);
});

test('browser app preserves backend-defined reasoning effort values without frontend whitelisting', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const requests = [];
  let savedSettings = { model: null, reasoningEffort: 'deep-think' };

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
                  name: 'Claude thread',
                  runtime: {
                    turnStatus: 'idle',
                    activeTurnId: null,
                    diff: null,
                    realtime: { status: 'idle', sessionId: null, items: [] },
                  },
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
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [
            { value: '', label: '默认' },
            { value: 'deep-think', label: 'Deep Think' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
          },
        });
      }

      if (url === '/api/sessions/thread-1/settings' && (!options.method || options.method === 'GET')) {
        return jsonResponse(savedSettings);
      }

      if (url === '/api/sessions/thread-1/settings' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        savedSettings = body;
        return jsonResponse(body);
      }

      if (url === '/api/sessions/thread-1/turns' && options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}');
        requests.push({ url, method: options.method, body });
        return jsonResponse({
          turnId: 'turn-1',
          status: 'started',
          thread: {
            id: 'thread-1',
            name: 'Claude thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-1',
              diff: null,
              realtime: { status: 'running', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Claude thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'idle',
              activeTurnId: null,
              diff: null,
              realtime: { status: 'idle', sessionId: null, items: [] },
            },
            turns: [],
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}${options.method ? ` (${options.method})` : ''}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: null,
    reasoningEffort: 'deep-think',
  });
  assert.match(
    fakeDocument.approvalModeControls.innerHTML,
    /<option value="deep-think" selected>Deep Think<\/option>/,
  );

  app.setComposerDraft('use the configured reasoning');
  await app.sendTurn();

  assert.deepEqual(requests, [
    {
      url: '/api/sessions/thread-1/turns',
      method: 'POST',
      body: {
        text: 'use the configured reasoning',
        model: null,
        reasoningEffort: 'deep-think',
        attachments: [],
      },
    },
  ]);
});

test('browser app restores pending approvals after reconnect and keeps applying approval sse events', async () => {
  const approvalOne = {
    id: 'approval-1',
    threadId: 'thread-1',
    kind: 'commandExecution',
    summary: 'Run npm test',
    detail: { command: 'npm test', cwd: '/tmp/workspace-a' },
    status: 'pending',
  };
  const approvalTwo = {
    id: 'approval-2',
    threadId: 'thread-1',
    kind: 'fileChange',
    summary: 'Review src/app.js',
    detail: { path: 'src/app.js' },
    status: 'pending',
  };
  const fakeStorage = createFakeStorage();
  const eventSources = [];
  let pendingApprovals = [approvalOne];

  const fetchImpl = async (url, options = {}) => {
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
      return jsonResponse({ mode: 'manual' });
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
  };

  const eventSourceFactory = () => {
    const source = createFakeEventSource();
    eventSources.push(source);
    return source;
  };

  const firstDocument = createFakeDocument();
  const firstApp = createAppController({
    fetchImpl,
    eventSourceFactory,
    documentRef: firstDocument,
    storageImpl: fakeStorage,
  });

  await firstApp.loadSessions();
  await firstApp.loadApprovalMode();
  await firstApp.selectSession('thread-1');

  assert.equal(eventSources.length, 1);
  assert.match(firstDocument.conversationBody.innerHTML, /Run npm test/);

  firstApp.destroy();

  assert.equal(eventSources[0].closed, true);

  const secondDocument = createFakeDocument();
  const secondApp = createAppController({
    fetchImpl,
    eventSourceFactory,
    documentRef: secondDocument,
    storageImpl: fakeStorage,
  });

  await secondApp.loadSessions();
  await secondApp.loadApprovalMode();
  await secondApp.selectSession('thread-1');

  assert.equal(eventSources.length, 2);
  assert.match(secondDocument.conversationBody.innerHTML, /Run npm test/);

  pendingApprovals = [approvalOne, approvalTwo];
  eventSources[1].emit({
    type: 'approval_requested',
    threadId: 'thread-1',
    payload: {
      approval: approvalTwo,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(secondDocument.conversationBody.innerHTML, /Review src\/app\.js/);

  pendingApprovals = [approvalTwo];
  eventSources[1].emit({
    type: 'approval_resolved',
    threadId: 'thread-1',
    payload: {
      approval: {
        ...approvalOne,
        status: 'approved',
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(secondDocument.conversationBody.innerHTML, /Run npm test/);
  assert.match(secondDocument.conversationBody.innerHTML, /Review src\/app\.js/);
});

test('browser app prevents duplicate approval mode submissions and swallows approval-mode failures', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const modeRequest = createDeferred();
  let modeRequestCount = 0;
  let failModeRequest = false;
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
              focusedSessions: [],
              historySessions: { active: [], archived: [] },
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
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/approval-mode' && options.method === 'POST') {
        modeRequestCount += 1;
        if (failModeRequest) {
          return jsonErrorResponse({ error: 'mode failed' }, 500);
        }

        return modeRequest.promise;
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.loadApprovalMode();

  const firstModeRequest = app.setApprovalMode('auto-approve');
  const secondModeRequest = app.setApprovalMode('manual');

  assert.equal(modeRequestCount, 1);

  modeRequest.resolve(jsonResponse({ mode: 'auto-approve' }));

  assert.deepEqual(await Promise.all([firstModeRequest, secondModeRequest]), [
    { mode: 'auto-approve' },
    null,
  ]);

  failModeRequest = true;
  const failedModeRequest = await app.setApprovalMode('manual');

  assert.equal(failedModeRequest, null);
});

test('browser app prevents duplicate approval resolutions and swallows approval resolution failures', async () => {
  const fakeDocument = createFakeDocument();
  const fakeEventSource = createFakeEventSource();
  const approvalRequest = createDeferred();
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
  let approveRequestCount = 0;
  let denyRequestCount = 0;
  let failDenyRequest = false;
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
              historySessions: { active: [], archived: [] },
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

      if (url === '/api/approvals/approval-1/approve' && options.method === 'POST') {
        approveRequestCount += 1;
        return approvalRequest.promise;
      }

      if (url === '/api/approvals/approval-1/deny' && options.method === 'POST') {
        denyRequestCount += 1;
        if (failDenyRequest) {
          return jsonErrorResponse({ error: 'deny failed' }, 500);
        }

        return jsonResponse({ ok: true });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
  });

  await app.loadSessions();
  await app.selectSession('thread-1');

  const firstApproveRequest = app.approveRequest('approval-1');
  const secondApproveRequest = app.approveRequest('approval-1');

  assert.equal(approveRequestCount, 1);

  pendingApprovals = [];
  approvalRequest.resolve(jsonResponse({ ok: true }));

  assert.deepEqual(await Promise.all([firstApproveRequest, secondApproveRequest]), [
    { ok: true },
    null,
  ]);

  pendingApprovals = [
    {
      id: 'approval-1',
      threadId: 'thread-1',
      kind: 'commandExecution',
      summary: 'Run npm test',
      detail: { command: 'npm test', cwd: '/tmp/workspace-a' },
      status: 'pending',
    },
  ];
  failDenyRequest = true;
  const failedDenyRequest = await app.denyRequest('approval-1');

  assert.equal(denyRequestCount, 1);
  assert.equal(failedDenyRequest, null);
});

test('browser app stays on a login gate until shared-password auth succeeds, then can logout again', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage();
  let eventSourceCount = 0;
  let loginAttemptCount = 0;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/auth/session') {
        return jsonErrorResponse({ authenticated: false, required: true }, 401);
      }

      if (url === '/api/auth/login') {
        loginAttemptCount += 1;
        const { password } = JSON.parse(options.body ?? '{}');
        if (password !== 'demo-password') {
          return jsonErrorResponse({ error: '密码不正确' }, 401);
        }

        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'web-agent-auth=demo' },
        });
      }

      if (url === '/api/auth/logout') {
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'web-agent-auth=; Max-Age=0' },
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

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: {
            model: null,
            reasoningEffort: null,
          },
        });
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => {
      eventSourceCount += 1;
      return createFakeEventSource();
    },
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.bootstrap();

  assert.equal(app.getState().auth.required, true);
  assert.equal(app.getState().auth.authenticated, false);
  assert.equal(fakeDocument.authGate.hidden, false);
  assert.equal(fakeDocument.appLayout.dataset.authLocked, 'true');
  assert.equal(fakeDocument.sessionList.hidden, false);
  assert.equal(fakeDocument.composer.hidden, false);
  assert.equal(fakeDocument.projectPanelToggle.hidden, false);
  assert.equal(fakeDocument.activityPanelToggle.hidden, false);
  assert.equal(eventSourceCount, 0);

  const failedLogin = await app.login('wrong-password');
  assert.equal(failedLogin, null);
  assert.equal(app.getState().auth.error, '密码不正确');
  assert.equal(loginAttemptCount, 1);
  assert.equal(eventSourceCount, 0);

  await app.login('demo-password');

  assert.equal(app.getState().auth.authenticated, true);
  assert.equal(fakeDocument.authGate.hidden, true);
  assert.equal(fakeDocument.appLayout.dataset.authLocked, 'false');
  assert.equal(fakeDocument.logoutButton.hidden, false);
  assert.equal(eventSourceCount, 1);
  assert.equal(fakeDocument.sendButton.textContent, '发送');

  await app.logout();

  assert.equal(app.getState().auth.authenticated, false);
  assert.equal(fakeDocument.authGate.hidden, false);
  assert.equal(fakeDocument.logoutButton.hidden, true);
});

test('browser app falls back to the login gate when a protected request later returns 401', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage();
  const fakeEventSource = createFakeEventSource();
  let sendTurnCount = 0;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/auth/session') {
        return jsonResponse({ authenticated: true, required: true });
      }

      if (url === '/api/status') {
        return jsonResponse({
          overall: 'connected',
          backend: { status: 'connected' },
          relay: { status: 'online' },
          lastError: null,
        });
      }

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

      if (url === '/api/session-options') {
        return jsonResponse({
          modelOptions: [{ value: '', label: '默认' }],
          reasoningEffortOptions: [{ value: '', label: '默认' }],
          defaults: {
            model: null,
            reasoningEffort: null,
          },
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Focus thread',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-1/turns') {
        sendTurnCount += 1;
        return jsonErrorResponse({ error: 'Authentication required' }, 401);
      }

      throw new Error(`Unhandled fetch url: ${url}`);
    },
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: fakeStorage,
  });

  await app.bootstrap();
  await app.selectSession('thread-1');
  app.setComposerDraft('continue');

  const sendResult = await app.sendTurn('continue');

  assert.equal(sendResult, null);
  assert.equal(sendTurnCount, 1);
  assert.equal(app.getState().auth.required, true);
  assert.equal(app.getState().auth.authenticated, false);
  assert.equal(app.getState().selectedSessionId, null);
  assert.equal(fakeDocument.authGate.hidden, false);
  assert.equal(fakeDocument.appLayout.dataset.authLocked, 'true');
  assert.equal(fakeDocument.sessionList.hidden, false);
  assert.equal(fakeDocument.composer.hidden, false);
  assert.equal(fakeEventSource.closed, true);
});

test('browser app delays project session creation until the first send', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let createdProjectSession = false;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: createdProjectSession
                ? [{ id: 'thread-3', name: 'Project session' }]
                : [],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-a/sessions' && options.method === 'POST') {
        createdProjectSession = true;
        requests.push({ url, method: options.method });
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

      if (url === '/api/sessions/thread-3') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          thread: {
            id: 'thread-3',
            name: 'Project session',
            cwd: '/tmp/workspace-a',
            turns: [],
          },
        });
      }

      if (url === '/api/sessions/thread-3/turns' && options.method === 'POST') {
        requests.push({
          url,
          method: options.method,
          body: JSON.parse(options.body),
        });
        return jsonResponse({ turnId: 'turn-1', status: 'started' }, 202);
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

  await app.startSessionInProject('/tmp/workspace-a');

  assert.equal(app.getState().pendingSessionProjectId, '/tmp/workspace-a');
  assert.equal(app.getState().selectedSessionId, null);
  assert.equal(fakeDocument.conversationTitle.textContent, '新会话');
  assert.match(fakeDocument.conversationBody.innerHTML, /发送第一条消息后创建/);
  assert.equal(fakeDocument.sendButton.disabled, true);
  assert.deepEqual(requests, [{ url: '/api/sessions', method: 'GET' }]);

  app.setComposerDraft('first message');

  assert.equal(fakeDocument.sendButton.disabled, false);

  await app.sendTurn('first message');

  assert.equal(app.getState().pendingSessionProjectId, null);
  assert.equal(app.getState().selectedSessionId, 'thread-3');
  assert.equal(app.getState().turnStatusBySession['thread-3'], 'started');
  assert.equal(fakeDocument.conversationTitle.textContent, 'Project session');
  assert.deepEqual(requests, [
    { url: '/api/sessions', method: 'GET' },
    { url: '/api/projects/%2Ftmp%2Fworkspace-a/sessions', method: 'POST' },
    { url: '/api/sessions', method: 'GET' },
    { url: '/api/sessions/thread-3', method: 'GET' },
    {
      url: '/api/sessions/thread-3/turns',
      method: 'POST',
      body: {
        text: 'first message',
        model: null,
        reasoningEffort: null,
        attachments: [],
      },
    },
  ]);
});

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

test('browser app can close a project from the sidebar activity state', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let projectClosed = false;
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        return jsonResponse({
          projects: projectClosed
            ? [
                {
                  id: '/tmp/workspace-a',
                  cwd: '/tmp/workspace-a',
                  displayName: 'workspace-a',
                  collapsed: false,
                  focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
                  historySessions: { active: [], archived: [] },
                },
              ]
            : [
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
        });
      }

      if (url === '/api/projects/%2Ftmp%2Fworkspace-b' && options.method === 'DELETE') {
        projectClosed = true;
        requests.push({ url, method: options.method });
        return jsonResponse({ ok: true });
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

  assert.equal(app.getState().projects.length, 2);
  assert.match(fakeDocument.sessionList.innerHTML, /workspace-b/);

  await app.closeProject('/tmp/workspace-b');

  assert.equal(app.getState().projects.length, 1);
  assert.equal(app.getState().projects[0].id, '/tmp/workspace-a');
  assert.doesNotMatch(fakeDocument.sessionList.innerHTML, /workspace-b/);
  assert.deepEqual(requests, [
    {
      url: '/api/projects/%2Ftmp%2Fworkspace-b',
      method: 'DELETE',
    },
  ]);
});

test('browser app can rename a selected session and sync the title plus project tree', async () => {
  const requests = [];
  const fakeDocument = createFakeDocument();
  let threadName = 'Old session name';
  const app = createAppController({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/sessions') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          projects: [
            {
              id: '/tmp/workspace-a',
              cwd: '/tmp/workspace-a',
              displayName: 'workspace-a',
              collapsed: false,
              focusedSessions: [{ id: 'thread-1', name: threadName, cwd: '/tmp/workspace-a' }],
              historySessions: { active: [], archived: [] },
            },
          ],
        });
      }

      if (url === '/api/sessions/thread-1') {
        requests.push({ url, method: options.method ?? 'GET' });
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: threadName,
            cwd: '/tmp/workspace-a',
            turns: [{ id: 'turn-1', status: 'completed', items: [] }],
          },
        });
      }

      if (url === '/api/sessions/thread-1/name' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        threadName = body.name;
        requests.push({ url, method: options.method, body });
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: threadName,
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
  const renamed = await app.renameSession('thread-1', 'Renamed session');

  assert.equal(renamed.thread.name, 'Renamed session');
  assert.equal(fakeDocument.conversationTitle.textContent, 'Renamed session');
  assert.match(fakeDocument.conversationBody.innerHTML, /Renamed session/);
  assert.match(fakeDocument.sessionList.innerHTML, /Renamed session/);
  assert.deepEqual(requests, [
    {
      url: '/api/sessions',
      method: 'GET',
    },
    {
      url: '/api/sessions/thread-1',
      method: 'GET',
    },
    {
      url: '/api/sessions/thread-1/name',
      method: 'POST',
      body: { name: 'Renamed session' },
    },
    {
      url: '/api/sessions',
      method: 'GET',
    },
    {
      url: '/api/sessions/thread-1',
      method: 'GET',
    },
  ]);
});

test('browser app renders realtime summaries in the conversation and activity panel', async () => {
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
  await app.selectSession('thread-1');

  fakeEventSource.emit({
    type: 'thread_realtime_started',
    payload: { threadId: 'thread-1', sessionId: 'rt-session-1' },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_item_added',
    payload: {
      threadId: 'thread-1',
      item: { type: 'response.created', response: { id: 'resp-1' } },
    },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_audio_delta',
    payload: {
      threadId: 'thread-1',
      audio: {
        data: 'AAA=',
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 480,
      },
    },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_error',
    payload: { threadId: 'thread-1', message: 'stream failed' },
  });
  fakeEventSource.emit({
    type: 'thread_realtime_closed',
    payload: { threadId: 'thread-1', reason: 'completed' },
  });

  assert.match(fakeDocument.conversationBody.innerHTML, /rt-session-1/);
  assert.match(fakeDocument.conversationBody.innerHTML, /response\.created/);
  assert.match(fakeDocument.conversationBody.innerHTML, /stream failed/);
  assert.match(fakeDocument.activityPanel.innerHTML, /实时/);
  assert.match(fakeDocument.activityPanel.innerHTML, /closed/);
  assert.match(fakeDocument.activityPanel.innerHTML, /audio/i);
  assert.match(fakeDocument.activityPanel.innerHTML, /completed/);
});

test('browser app restores remembered panel preferences automatically and persists panel toggles', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage({
    'codex.webAgentConsole.preferences.v1': JSON.stringify({
      projectPanelCollapsed: true,
      activityPanelCollapsed: false,
      theme: 'light',
    }),
  });
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
    storageImpl: fakeStorage,
  });

  await app.loadSessions();

  assert.equal(app.getState().persistPanelPreference, true);
  assert.equal(app.getState().projectPanelCollapsed, true);
  assert.equal(app.getState().activityPanelCollapsed, false);
  assert.equal(fakeDocument.appLayout.dataset.projectPanel, 'collapsed');
  assert.equal(fakeDocument.appLayout.dataset.activityPanel, 'expanded');
  assert.equal(fakeDocument.appLayout.dataset.theme, 'light');

  app.toggleActivityPanel();

  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: true,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );

  app.openHistoryDialog('/tmp/workspace-a');
  assert.doesNotMatch(fakeDocument.historyDialog.innerHTML, /记住侧栏开关状态/);
  assert.doesNotMatch(fakeDocument.historyDialog.innerHTML, /data-panel-preference-toggle/);

  app.toggleProjectPanel();

  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );
});

test('browser app restores remembered dark theme preference and persists theme toggles', async () => {
  const fakeDocument = createFakeDocument();
  const fakeStorage = createFakeStorage({
    'codex.webAgentConsole.preferences.v1': JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'dark',
    }),
  });
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
    storageImpl: fakeStorage,
  });

  await app.loadSessions();

  assert.equal(app.getState().theme, 'dark');
  assert.equal(fakeDocument.appLayout.dataset.theme, 'dark');
  assert.match(fakeDocument.sessionList.innerHTML, /data-theme-toggle="true"/);
  assert.match(fakeDocument.sessionList.innerHTML, /aria-label="切换到浅色主题"/);
  assert.match(fakeDocument.sessionList.innerHTML, /☀/);

  app.toggleTheme();

  assert.equal(app.getState().theme, 'light');
  assert.equal(fakeDocument.appLayout.dataset.theme, 'light');
  assert.match(fakeDocument.sessionList.innerHTML, /aria-label="切换到暗色主题"/);
  assert.match(fakeDocument.sessionList.innerHTML, /☾/);
  assert.equal(
    fakeStorage.getItem('codex.webAgentConsole.preferences.v1'),
    JSON.stringify({
      projectPanelCollapsed: false,
      activityPanelCollapsed: true,
      theme: 'light',
    }),
  );
});

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

test('shell html removes the generic conversation title and renames panel controls', () => {
  const html = readPublicFile('index.html');

  assert.match(
    html,
    /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" \/>/,
  );
  assert.match(html, /<span class="panel-toggle-label">项目\/会话<\/span>/);
  assert.match(html, /<span class="panel-toggle-label">活动\/任务<\/span>/);
  assert.match(html, /class="panel-toggle-mobile-glyph" aria-hidden="true">/);
  assert.match(html, /class="panel-toggle-mobile-bar"/);
  assert.match(html, /id="conversation-status"/);
  assert.match(html, /class="conversation-status conversation-status--connected"/);
  assert.match(html, /class="conversation-status-label">在线<\/span>/);
  assert.match(
    html,
    /<div class="conversation-header-title">\s*<div id="conversation-title" class="conversation-title" hidden><\/div>\s*<\/div>\s*<div id="conversation-status" class="conversation-status conversation-status--connected" role="status" aria-live="polite">[\s\S]*?<\/div>\s*<button[\s\S]*?id="activity-panel-toggle"/,
  );
  assert.match(html, /class="session-dock"/);
  assert.match(html, /id="session-dock-plan-summary"/);
  assert.match(html, /class="composer-action-row"/);
  assert.match(html, /class="composer-footer"/);
  assert.match(html, /data-composer-attach-trigger="true"/);
  assert.match(html, /id="composer-inline-feedback"/);
  assert.match(html, /class="sr-only">显示导航跳转按钮</);
  assert.match(html, /class="composer-nav-toggle-icon" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, />显示回合跳转按钮</);
  assert.match(html, /aria-label="调整项目\/会话宽度"/);
  assert.match(html, /aria-label="调整活动宽度"/);
  assert.match(html, /id="activity-panel-toggle"[\s\S]*aria-expanded="false"/);
  assert.doesNotMatch(html, />会话视图</);
  assert.doesNotMatch(html, /id="logout-button"/);
  assert.match(html, /<\/main>\s*<div id="auth-gate" class="auth-gate" hidden>/);
});

test('sidebar and mobile drawer render a fixed logout action in the sessions panel', () => {
  const state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
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
    },
  });

  const sidebarHtml = renderProjectSidebar({
    ...state,
    auth: {
      required: true,
      authenticated: true,
      checking: false,
      pending: false,
      error: null,
    },
  });
  const activityDrawerHtml = renderHistoryDialog({
    ...state,
    historyDialogProjectId: '/tmp/workspace-a',
  });

  assert.match(sidebarHtml, /退出登录/);
  assert.match(sidebarHtml, /data-logout-button="true"/);
  assert.match(sidebarHtml, /data-theme-toggle="true"/);
  assert.match(sidebarHtml, /sidebar-footer-actions/);
  assert.match(sidebarHtml, /aria-label="切换到暗色主题"/);
  assert.match(sidebarHtml, /sidebar-footer/);
  assert.match(activityDrawerHtml, /history-dialog/);
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

test('conversation css clamps horizontal overflow in the main thread viewport', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /\.panel-scroll-body\s*\{[^}]*overflow-x:\s*hidden;/s);
  assert.match(css, /\.thread-view\s*\{[^}]*min-width:\s*0;/s);
  assert.doesNotMatch(css, /\.message-markdown pre\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.doesNotMatch(css, /\.message-markdown table\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.doesNotMatch(css, /\.diff-view\s*\{[^}]*overflow:\s*auto;/s);
});

test('conversation status css renders a glowing header light with compact text in the top-right corner', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.conversation-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto auto;[^}]*grid-template-areas:\s*"project title status activity";/s,
  );
  assert.match(css, /\.conversation-status\s*\{[^}]*grid-area:\s*status;[^}]*justify-self:\s*end;/s);
  assert.match(
    css,
    /\.conversation-status-light\s*\{[^}]*width:\s*(12|13|14)px;[^}]*height:\s*(12|13|14)px;[^}]*box-shadow:\s*0 0 0 [^;]+,\s*0 0 [^;]+;/s,
  );
  assert.match(
    css,
    /\.conversation-status--connected\s+\.conversation-status-light\s*\{[^}]*background:\s*#2b7d48;[^}]*box-shadow:\s*0 0 0 [^;]+,\s*0 0 [^;]+;/s,
  );
  assert.match(
    css,
    /@media \(max-width:\s*760px\)\s*\{[\s\S]*\.conversation-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);[^}]*grid-template-areas:\s*"project status"\s*"title title";/s,
  );
});

test('auth css uses a fullscreen high-blur overlay while the login gate is visible', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.auth-gate\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*pointer-events:\s*auto;[^}]*backdrop-filter:\s*blur\((3[2-9]|[4-9]\d)px\)/s,
  );
  assert.match(css, /\.auth-gate\s*\{[^}]*z-index:\s*40;/s);
  assert.match(css, /\.auth-gate\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
});

test('layout css pins panels to fixed grid tracks when sidebars collapse', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /#session-list\s*\{[^}]*grid-column:\s*1;/s);
  assert.match(css, /#project-panel-resizer\s*\{[^}]*grid-column:\s*2;/s);
  assert.match(css, /#conversation-panel\s*\{[^}]*grid-column:\s*3;/s);
  assert.match(css, /#activity-panel-resizer\s*\{[^}]*grid-column:\s*4;/s);
  assert.match(css, /#activity-panel\s*\{[^}]*grid-column:\s*5;/s);
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#session-list,\s*#project-panel-resizer,\s*#conversation-panel,\s*#activity-panel-resizer,\s*#activity-panel\s*\{[^}]*grid-column:\s*1;/s,
  );
});

test('mobile layout css keeps the conversation pinned to the viewport with a fixed bottom composer', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*body\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.layout\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#conversation-panel\s*\{[^}]*padding:\s*max\(12px,\s*env\(safe-area-inset-top\)\)\s*12px\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#composer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;[^}]*background:\s*linear-gradient\(180deg,\s*rgba\(248,\s*250,\s*252,\s*0\.72\),\s*rgba\(244,\s*247,\s*250,\s*0\.88\)\);/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-scroll-body\s*\{[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-scroll-body\s*\{[^}]*padding-right:\s*0;/s,
  );
  assert.doesNotMatch(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-scroll-body\s*\{[^}]*overflow:\s*visible;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#activity-panel-toggle\s*\{[^}]*display:\s*none\s*!important;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-toggle-mobile-glyph\s*\{[^}]*display:\s*inline-flex;/s,
  );
  assert.match(
    css,
    /\.panel-toggle-mobile-glyph\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*4px;/s,
  );
  assert.match(
    css,
    /\.panel-toggle-mobile-bar\s*\{[^}]*width:\s*18px;[^}]*height:\s*2px;[^}]*background:\s*currentColor;/s,
  );
  assert.match(
    css,
    /\.mobile-project-sidebar\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*100%;/s,
  );
  assert.match(
    css,
    /\.mobile-project-sidebar\s+\.sidebar-footer\s*\{[^}]*margin-top:\s*auto;[^}]*position:\s*static;/s,
  );
  assert.match(css, /\.mobile-drawer-close\s*\{[^}]*border-radius:\s*999px;/s);
});

test('mobile composer css collapses settings into a summary strip and keeps the action row compact', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#composer-input\s*\{[^}]*min-height:\s*(8[0-9]|9[0-9])px;[^}]*max-height:\s*(1[4-9][0-9]|200)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.composer-action-row\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*flex-end;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.composer-footer\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*flex-start;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-shell\s*\{[^}]*display:\s*grid;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-summary\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-summary-icon\s*\{[^}]*display:\s*inline-flex;[^}]*width:\s*(14|15|16)px;[^}]*height:\s*(14|15|16)px;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-panel\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-confirm\s*\{[^}]*min-height:\s*(34|35|36)px;[^}]*border-radius:\s*(10|11|12)px;/s,
  );
});

test('mobile conversation css keeps turn cards, plan steps, and message bubbles compact', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-nav\s*\{[^}]*margin-top:\s*(6|7|8)px;[^}]*padding:\s*(6|7|8)px\s+0\s+(1|2|3)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-nav-button\s*\{[^}]*padding:\s*(5|6|7)px\s+(8|9|10)px;[^}]*font-size:\s*11px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.turn-card-header\s*\{[^}]*margin-bottom:\s*(5|6|7|8)px;[^}]*font-size:\s*11px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-item-card\s*\{[^}]*padding:\s*(8|9)px\s+(10|11)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-item-card\s*\{[^}]*margin-bottom:\s*(5|6|7)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.task-plan-step\s*\{[^}]*padding:\s*(8|9|10)px\s+(9|10|11)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.message-bubble\s*\{[^}]*padding:\s*(8|9|10)px\s+(10|11|12)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.message-bubble\s*\{[^}]*margin-bottom:\s*(6|7|8)px;/s,
  );
});

test('sidebar css keeps session rows compact and close buttons centered', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /\.focused-session-row\s*\{[^}]*overflow:\s*visible;[^}]*border-radius:\s*8px;/s);
  assert.match(css, /\.session-item,\s*\.focus-remove,\s*#composer button\s*\{[^}]*border-radius:\s*8px;/s);
  assert.match(
    css,
    /\.project-close\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1;/s,
  );
  assert.match(
    css,
    /\.focus-remove--embedded\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1;/s,
  );
  assert.match(
    css,
    /\.history-dialog-close\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*padding:\s*0;/s,
  );
  assert.match(css, /\.sidebar-footer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);
  assert.match(css, /\.sidebar-footer-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*(8|9|10)px;/s);
  assert.match(css, /\.sidebar-logout-button\s*\{[^}]*flex:\s*1\s+1\s+auto;/s);
  assert.match(
    css,
    /\.sidebar-theme-toggle\s*\{[^}]*width:\s*(42|44)px;[^}]*min-width:\s*(42|44)px;[^}]*min-height:\s*(42|44)px;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
  );
});

test('theme css adds a dark palette and transparent icon toggle affordance', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /body\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;[^}]*background:[^}]*linear-gradient/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.panel\s*\{[^}]*background:\s*rgba\([^)]*\);[^}]*box-shadow:\s*0 18px 60px rgba\(/s,
  );
  assert.match(
    css,
    /\.sidebar-theme-toggle:hover\s*\{[^}]*background:\s*rgba\([^)]*\);/s,
  );
  assert.match(
    css,
    /\.sidebar-theme-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid rgba\(/s,
  );
});

test('sidebar and conversation css keep emphasis lightweight', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.session-item--focused\[aria-current="true"\]\s*\{[^}]*color:\s*#112031;[^}]*box-shadow:\s*0 10px 24px rgba\(17, 32, 49, 0\.08\);/s,
  );
  assert.doesNotMatch(
    css,
    /\.session-item--focused\[aria-current="true"\]\s*\{[^}]*linear-gradient\(135deg,\s*#112031,\s*#20394e\);/s,
  );
  assert.match(
    css,
    /\.project-action--primary\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.96\);[^}]*color:\s*#3e5f80;/s,
  );
  assert.doesNotMatch(css, /\.project-action--primary\s*\{[^}]*linear-gradient/s);
  assert.match(
    css,
    /#send-button\[data-action="interrupt"\]\s*\{[^}]*background:\s*linear-gradient\(180deg,\s*#d98a2b,\s*#b66a16\);/s,
  );
  assert.match(
    css,
    /\.turn-card\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-top:\s*1px solid rgba\(17, 32, 49, 0\.08\);/s,
  );
  assert.match(
    css,
    /\.thread-item-card\s*\{[^}]*padding:\s*10px 12px;[^}]*border-radius:\s*14px;[^}]*border:\s*1px solid rgba\(17, 32, 49, 0\.06\);[^}]*background:\s*rgba\(255, 255, 255, 0\.76\);/s,
  );
});

test('composer control css keeps session selectors compact, uses an icon nav toggle, and hides the secondary interrupt button', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.composer-toolbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
  );
  assert.match(
    css,
    /\.approval-mode-shell\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    css,
    /\.approval-mode-select\s*\{[^}]*min-height:\s*32px;[^}]*font-size:\s*11px;/s,
  );
  assert.match(
    css,
    /\.composer-toolbar-secondary\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*flex-end;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    css,
    /\.composer-nav-toggle\s*\{[^}]*width:\s*34px;[^}]*height:\s*32px;[^}]*border-radius:\s*999px;/s,
  );
  assert.match(
    css,
    /\.composer-nav-toggle input\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*opacity:\s*0;/s,
  );
  assert.match(
    css,
    /\.composer-nav-toggle-icon\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s,
  );
  assert.match(
    css,
    /#interrupt-button\s*\{[^}]*display:\s*none;/s,
  );
});

test('desktop composer css keeps controls on a compact single row when space allows', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.composer-toolbar\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*center;[^}]*justify-content:\s*flex-end;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*margin-left:\s*auto;/s,
  );
  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.approval-mode-controls-slot\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 1 auto;/s,
  );
  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.composer-toolbar-secondary\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 1 auto;[^}]*justify-content:\s*flex-end;/s,
  );
  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.approval-mode-group\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*120px;/s,
  );
});

test('thread item card css separates status chips from disclosure toggles and styles file changes compactly', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /\.thread-item-card-summary-meta\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*8px;/s);
  assert.match(css, /\.thread-item-card-status--failed\s*\{[^}]*background:[^}]*rgba\(176,\s*55,\s*55,\s*0\.12\)/s);
  assert.match(css, /\.thread-item-card-toggle\s*\{[^}]*border:\s*1px solid rgba\(17,\s*32,\s*49,\s*0\.08\);/s);
  assert.match(css, /\.thread-item-card-toggle-label\s*\{[^}]*font-size:\s*11px;/s);
  assert.match(css, /\.thread-item-card--fileChange\s*\{[^}]*background:\s*rgba\(244,\s*242,\s*255,\s*0\.76\);/s);
});

function createFakeEventSource() {
  return {
    onmessage: null,
    closed: false,
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    },
    close() {
      this.closed = true;
    },
  };
}

function assertTaskSummaryItem(html, group, text) {
  assert.match(
    String(html ?? ''),
    new RegExp(
      `data-task-summary-item-group="${escapeRegExp(group)}"[\\s\\S]*?${escapeRegExp(text)}`,
    ),
  );
}

function assertComposerSetting(html, key, label, value) {
  const normalizedHtml = String(html ?? '');
  assert.match(
    normalizedHtml,
    new RegExp(
      `data-composer-setting-label="${escapeRegExp(key)}"[\\s\\S]*?>${escapeRegExp(label)}<`,
    ),
  );
  assert.match(
    normalizedHtml,
    new RegExp(
      `data-composer-setting-value="${escapeRegExp(key)}"[\\s\\S]*?>${escapeRegExp(value)}<`,
    ),
  );
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function jsonErrorResponse(body, status = 500) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function createFakeDocument(options = {}) {
  const mobile = options.mobile === true;
  const appLayout = createFakeElement({ dataset: {} });
  const authGate = createFakeElement({ hidden: true });
  const loginForm = createFakeElement();
  const loginPassword = createFakeElement({ value: '' });
  const loginButton = createFakeElement({ textContent: '登录' });
  const loginError = createFakeElement({ textContent: '', hidden: true });
  const logoutButton = createFakeElement({ hidden: true });
  const sessionList = createFakeElement();
  const conversationBody = createFakeElement();
  const conversationNav = createFakeElement();
  const activityPanel = createFakeElement();
  const projectPanelToggle = createFakeElement({ dataset: {} });
  const activityPanelToggle = createFakeElement({ dataset: {} });
  const projectResizer = createFakeElement();
  const activityResizer = createFakeElement();
  const conversationStatus = createFakeElement({ dataset: {} });
  const conversationTitle = createFakeElement({ textContent: '会话视图' });
  const sessionDockPlanSummary = createFakeElement();
  const composer = createFakeElement();
  const composerAttachments = createFakeElement();
  const composerAttachmentError = createFakeElement();
  const composerInlineFeedback = createFakeElement();
  const composerInput = createFakeElement({ value: '' });
  const approvalModeControls = createFakeElement();
  const composerUploadFileButton = createFakeElement({ dataset: {} });
  const composerUploadFileAction = createFakeElement({ dataset: {} });
  const composerUploadImageButton = createFakeElement({ dataset: {} });
  const composerAttachmentMenu = createFakeElement();
  const composerFileInput = createFakeElement({ files: [], click() {} });
  const composerImageInput = createFakeElement({ files: [], click() {} });
  const conversationNavToggle = createFakeElement({ checked: true });
  const sendButton = createFakeElement({ textContent: '', dataset: {} });
  const interruptButton = createFakeElement({ dataset: {} });
  const conversationScroll = createFakeElement({ scrollTop: 0 });
  const mobileDrawer = createFakeElement({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  const historyDialog = createFakeElement({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });

  const elements = new Map([
    ['#app-layout', appLayout],
    ['#auth-gate', authGate],
    ['#login-form', loginForm],
    ['#login-password', loginPassword],
    ['#login-button', loginButton],
    ['#login-error', loginError],
    ['#logout-button', logoutButton],
    ['#session-list', sessionList],
    ['#conversation-body', conversationBody],
    ['#conversation-nav', conversationNav],
    ['#activity-panel', activityPanel],
    ['#project-panel-toggle', projectPanelToggle],
    ['#activity-panel-toggle', activityPanelToggle],
    ['#project-panel-resizer', projectResizer],
    ['#activity-panel-resizer', activityResizer],
    ['#conversation-status', conversationStatus],
    ['#conversation-title', conversationTitle],
    ['#session-dock-plan-summary', sessionDockPlanSummary],
    ['#composer', composer],
    ['#composer-attachments', composerAttachments],
    ['#composer-attachment-error', composerAttachmentError],
    ['#composer-inline-feedback', composerInlineFeedback],
    ['#composer-input', composerInput],
    ['#approval-mode-controls', approvalModeControls],
    ['#composer-upload-file', composerUploadFileButton],
    ['#composer-upload-file-action', composerUploadFileAction],
    ['#composer-upload-image', composerUploadImageButton],
    ['#composer-attachment-menu', composerAttachmentMenu],
    ['#composer-file-input', composerFileInput],
    ['#composer-image-input', composerImageInput],
    ['#conversation-nav-toggle', conversationNavToggle],
    ['#send-button', sendButton],
    ['#interrupt-button', interruptButton],
    ['#conversation-scroll', conversationScroll],
    ['#mobile-drawer', mobileDrawer],
    ['#history-dialog', historyDialog],
  ]);

  wireConversationMetrics(conversationBody, conversationScroll);
  wireComposerMarkup({
    composer,
    sessionDockPlanSummary,
    composerAttachments,
    composerAttachmentError,
    composerInlineFeedback,
    approvalModeControls,
    composerUploadFileButton,
    composerUploadFileAction,
    composerUploadImageButton,
    composerAttachmentMenu,
    conversationNavToggle,
    sendButton,
    interruptButton,
  });

  return {
    appLayout,
    authGate,
    loginForm,
    loginPassword,
    loginButton,
    loginError,
    logoutButton,
    sessionList,
    conversationBody,
    conversationNav,
    activityPanel,
    projectPanelToggle,
    activityPanelToggle,
    projectResizer,
    activityResizer,
    conversationStatus,
    conversationTitle,
    sessionDockPlanSummary,
    composer,
    composerAttachments,
    composerAttachmentError,
    composerInlineFeedback,
    composerInput,
    approvalModeControls,
    composerUploadFileButton,
    composerUploadFileAction,
    composerUploadImageButton,
    composerAttachmentMenu,
    composerFileInput,
    composerImageInput,
    conversationNavToggle,
    sendButton,
    interruptButton,
    conversationScroll,
    mobileDrawer,
    historyDialog,
    defaultView: createFakeWindow({ mobile }),
    querySelector(selector) {
      return elements.get(selector) ?? null;
    },
  };
}

function createFakeElement(overrides = {}) {
  const listeners = new Map();
  return {
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    open: false,
    hidden: false,
    value: '',
    textContent: '',
    disabled: false,
    checked: false,
    style: createFakeStyle(),
    addEventListener(type, handler) {
      if (!type || typeof handler !== 'function') {
        return;
      }

      const entries = listeners.get(type) ?? [];
      entries.push(handler);
      listeners.set(type, entries);
    },
    removeEventListener(type, handler) {
      if (!type || typeof handler !== 'function' || !listeners.has(type)) {
        return;
      }

      listeners.set(
        type,
        listeners.get(type).filter((entry) => entry !== handler),
      );
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
    click() {
      this.dispatchEvent({ type: 'click' });
    },
    scrollTo(options) {
      if (typeof options === 'number') {
        this.scrollTop = options;
        return;
      }

      if (options && typeof options.top === 'number') {
        this.scrollTop = options.top;
      }
    },
    focus() {},
    select() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    ...overrides,
  };
}

function createFakeStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    getPropertyValue(name) {
      return values.get(name) ?? '';
    },
  };
}

function createFakeWindow({ mobile }) {
  return {
    innerWidth: mobile ? 390 : 1280,
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    matchMedia(query) {
      return {
        media: query,
        matches: mobile && query.includes('max-width: 760px'),
        addEventListener() {},
        removeEventListener() {},
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function wireConversationMetrics(conversationBody, conversationScroll) {
  let value = conversationBody.innerHTML ?? '';
  Object.defineProperty(conversationBody, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      return value;
    },
    set(nextValue) {
      value = String(nextValue);
      if (!conversationScroll.__autoMeasureHeight) {
        return;
      }

      const turnCount = (value.match(/data-turn-card="/g) ?? []).length;
      const headerHeight = value.includes('thread-header') ? 280 : 0;
      conversationScroll.scrollHeight = turnCount * 120 + headerHeight;
    },
  });
}

function wireComposerMarkup({
  composer,
  sessionDockPlanSummary,
  composerAttachments,
  composerAttachmentError,
  composerInlineFeedback,
  approvalModeControls,
  composerUploadFileButton,
  composerUploadFileAction,
  composerUploadImageButton,
  composerAttachmentMenu,
  conversationNavToggle,
  sendButton,
  interruptButton,
}) {
  let value = composer.innerHTML ?? '';
  Object.defineProperty(composer, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      const attachmentMenuMarkup =
        composerAttachmentMenu.hidden
          ? ''
          : [
              '<div id="composer-attachment-menu">',
              composerUploadFileAction.hidden
                ? ''
                : `<button id="composer-upload-file-action">${composerUploadFileAction.textContent}</button>`,
              composerUploadImageButton.hidden
                ? ''
                : `<button id="composer-upload-image">${composerUploadImageButton.textContent}</button>`,
              '</div>',
            ].join('');
      return [
        sessionDockPlanSummary.hidden ? '' : sessionDockPlanSummary.innerHTML,
        composerAttachments.hidden ? '' : composerAttachments.innerHTML,
        `<button id="composer-upload-file" data-composer-attach-trigger="true" data-action="${composerUploadFileButton.dataset.action ?? ''}">${composerUploadFileButton.textContent}</button>`,
        attachmentMenuMarkup,
        composerAttachmentError.hidden
          ? ''
          : `<p id="composer-attachment-error">${composerAttachmentError.textContent}</p>`,
        composerInlineFeedback.hidden
          ? ''
          : `<p id="composer-inline-feedback">${composerInlineFeedback.textContent}</p>`,
        approvalModeControls.hidden ? '' : approvalModeControls.innerHTML,
        `<input id="conversation-nav-toggle"${conversationNavToggle.checked ? ' checked' : ''} />`,
        `<button id="send-button" data-action="${sendButton.dataset.action ?? ''}">${sendButton.textContent}</button>`,
        interruptButton.hidden
          ? ''
          : `<button id="interrupt-button">${interruptButton.textContent}</button>`,
      ].join('');
    },
    set(nextValue) {
      value = String(nextValue);
    },
  });
}

function createFakeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFakeFile({ name, type, text = '' }) {
  const encoded = new TextEncoder().encode(text);
  return {
    name,
    type,
    size: encoded.byteLength,
    async arrayBuffer() {
      return encoded.buffer.slice(0);
    },
    async text() {
      return text;
    },
  };
}

function createClipboardImageItem(file) {
  return {
    type: file.type,
    getAsFile() {
      return file;
    },
  };
}

function trackInnerHtmlWrites(element) {
  let value = element.innerHTML ?? '';
  let count = 0;
  Object.defineProperty(element, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      return value;
    },
    set(nextValue) {
      value = String(nextValue);
      count += 1;
    },
  });

  return {
    get count() {
      return count;
    },
  };
}
