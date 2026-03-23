import { test, assert, reduceState, renderProjectSidebar } from './shared.js';

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
