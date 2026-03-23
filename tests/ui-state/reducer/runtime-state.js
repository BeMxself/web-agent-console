import { test, assert, reduceState, renderProjectSidebar } from '../shared.js';

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
