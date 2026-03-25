import {
  test,
  assert,
  renderProjectSidebar,
  renderHistoryDialog,
  renderThreadDetail,
  findConversationTurnTarget,
} from './shared.js';

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
  assert.doesNotMatch(dialogHtml, /history-section-title/);
  assert.doesNotMatch(dialogHtml, /记住侧栏开关状态/);
  assert.doesNotMatch(dialogHtml, /data-panel-preference-toggle/);
  assert.match(dialogHtml, /Working thread/);
  assert.match(dialogHtml, /session-item-subtitle/);
  assert.doesNotMatch(dialogHtml, /Archived task/);
  assert.match(archivedDialogHtml, /Archived task/);
  assert.doesNotMatch(archivedDialogHtml, /Working thread/);
  assert.doesNotMatch(archivedDialogHtml, /history-section-title/);
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
  assert.match(detailHtml, /data-copy-thread-item="item-command-1"/);
  assert.match(detailHtml, /data-copy-thread-item="item-mcp-1"/);
  assert.match(detailHtml, /data-copy-thread-item="item-fallback-1"/);
  assert.match(detailHtml, /thread-item-card-summary-meta[\s\S]*thread-item-card-copy-button thread-item-card-copy-button--inline[\s\S]*data-copy-thread-item="item-command-1"/);
  assert.match(detailHtml, /thread-item-card-summary-meta[\s\S]*thread-item-card-copy-button thread-item-card-copy-button--inline[\s\S]*data-copy-thread-item="item-mcp-1"/);
  assert.match(detailHtml, /thread-item-card-summary-meta[\s\S]*thread-item-card-copy-button thread-item-card-copy-button--inline[\s\S]*data-copy-thread-item="item-fallback-1"/);
  assert.match(detailHtml, /thread-item-card--generic thread-item-card--collapsible/);
  assert.doesNotMatch(detailHtml, /thread-item-card--generic thread-item-card--collapsible" open/);
});

test('render helpers rename the user rewrite action to 修改', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-user-actions',
    name: 'User action session',
    cwd: '/tmp/workspace-a',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'Rewrite me', text_elements: [] }],
          },
        ],
      },
    ],
  });

  assert.match(detailHtml, /data-rewrite-user-message="user-1"/);
  assert.match(detailHtml, /data-copy-thread-item="user-1"/);
  assert.match(detailHtml, /message-icon-button/);
  assert.match(detailHtml, /aria-label="修改问题"/);
  assert.doesNotMatch(detailHtml, /从这里重写/);
  assert.doesNotMatch(detailHtml, />修改</);
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
              '[Local file](/tmp/workspace-a/src/app.js#L12)',
              '',
              '[File URI](file:///tmp/workspace-a/notes.md:8)',
              '',
              '<script>alert("xss")</script>',
            ].join('\n'),
          },
        ],
      },
    ],
  });

  assert.match(detailHtml, /message-markdown/);
  assert.match(detailHtml, /data-copy-thread-item="item-markdown-1"/);
  assert.match(detailHtml, /message-copy-button/);
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
  assert.match(detailHtml, /<a[^>]+href="\/tmp\/workspace-a\/src\/app\.js#L12"/);
  assert.match(
    detailHtml,
    /<a[^>]+data-local-file-path="\/tmp\/workspace-a\/src\/app\.js"[^>]+data-local-file-line="12"/,
  );
  assert.match(detailHtml, /<a[^>]+href="file:\/\/\/tmp\/workspace-a\/notes\.md:8"/);
  assert.match(
    detailHtml,
    /<a[^>]+data-local-file-path="\/tmp\/workspace-a\/notes\.md"[^>]+data-local-file-line="8"/,
  );
  assert.match(detailHtml, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(detailHtml, /<script>alert\("xss"\)<\/script>/);
});

test('render helpers show copy buttons on assistant and commentary message bubbles', () => {
  const detailHtml = renderThreadDetail({
    id: 'thread-agent-copy',
    name: 'Agent copy session',
    cwd: '/tmp/workspace-a',
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'agent-commentary-1',
            phase: 'commentary',
            text: 'Thinking through the repository layout.',
          },
          {
            type: 'agentMessage',
            id: 'agent-final-1',
            phase: 'final_answer',
            text: 'Final answer body.',
          },
        ],
      },
    ],
  });

  assert.match(detailHtml, /data-copy-thread-item="agent-commentary-1"/);
  assert.match(detailHtml, /data-copy-thread-item="agent-final-1"/);
  assert.match(detailHtml, /message-copy-button/);
});

test('render helpers number user attachment actions by attachment order instead of raw content index', () => {
  const detailHtml = renderThreadDetail(
    {
      id: 'thread-attachment-order',
      name: 'Attachment order',
      cwd: '/tmp/workspace-a',
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'user-1',
              content: [
                { type: 'text', text: 'Please inspect these files', text_elements: [] },
                {
                  type: 'image',
                  name: 'diagram.png',
                  mimeType: 'image/png',
                  url: 'data:image/png;base64,Zm9v',
                },
                {
                  type: 'attachmentSummary',
                  attachmentType: 'pdf',
                  name: 'report.pdf',
                  mimeType: 'application/pdf',
                  dataBase64: 'YmFy',
                },
              ],
            },
          ],
        },
      ],
    },
    null,
    {
      overall: 'connected',
      backend: { status: 'connected' },
      relay: { status: 'online' },
      lastError: null,
    },
  );

  assert.match(detailHtml, /data-message-attachment-item="user-1"[^>]+data-message-attachment-index="0"[\s\S]*diagram\.png/);
  assert.match(detailHtml, /data-message-attachment-item="user-1"[^>]+data-message-attachment-index="1"[\s\S]*report\.pdf/);
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
