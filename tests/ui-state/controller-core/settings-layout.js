import {
  test,
  assert,
  createAppController,
  createFakeDocument,
  createFakeEventSource,
  createFakeStorage,
  createDeferred,
  createFakeFile,
  createClipboardImageItem,
  assertTaskSummaryItem,
  assertComposerSetting,
  trackInnerHtmlWrites,
  jsonResponse,
  jsonErrorResponse,
} from '../shared.js';

function trackPropertyWrites(target, propertyName) {
  let value = target[propertyName];
  let count = 0;
  Object.defineProperty(target, propertyName, {
    configurable: true,
    enumerable: true,
    get() {
      return value;
    },
    set(nextValue) {
      value = nextValue;
      count += 1;
    },
  });

  return {
    get count() {
      return count;
    },
  };
}

function trackStyleSetPropertyCalls(style) {
  const originalSetProperty = style.setProperty.bind(style);
  let count = 0;
  style.setProperty = (name, value) => {
    count += 1;
    return originalSetProperty(name, value);
  };

  return {
    get count() {
      return count;
    },
  };
}


test('browser app loads session option catalogs, restores per-session settings, and disables controls for running sessions', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument();
  const settingsByThread = {
    'thread-1': {
      model: 'gpt-5.4',
      reasoningEffort: null,
      agentType: 'plan',
      sandboxMode: 'workspace-write',
    },
    'thread-2': {
      model: null,
      reasoningEffort: 'high',
      agentType: null,
      sandboxMode: 'read-only',
    },
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
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

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-agent-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /<span class="approval-mode-label">/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="" selected>默认<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="gpt-5\.4" selected>gpt-5\.4<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="plan" selected>计划<\/option>/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /<option value="workspace-write" selected>工作区可写<\/option>/);
  assert.deepEqual(app.getState().sessionSettingsById['thread-1'], {
    model: 'gpt-5.4',
    reasoningEffort: null,
    agentType: 'plan',
    sandboxMode: 'workspace-write',
  });

  await app.selectSession('thread-2');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-agent-select="true"[^>]*disabled/);
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

  assert.doesNotMatch(fakeDocument.composer.innerHTML, /暂无任务计划/);
  assert.equal(fakeDocument.sessionDockPlanSummary.hidden, true);
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
  assert.equal(fakeDocument.sendButton.dataset.action, 'busy');
  assert.match(fakeDocument.sendButton.textContent, /执行中/);
  assert.equal(fakeDocument.interruptButton.hidden, false);
  assert.equal(fakeDocument.interruptButton.dataset.action, 'interrupt');

  fakeDocument.interruptButton.dispatchEvent({ type: 'click' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.some((request) => request.url === '/api/sessions/thread-1/interrupt'), true);
  assert.equal(
    requests.some((request) => request.url === '/api/turn' && request.method === 'POST'),
    false,
  );
  assert.equal(fakeDocument.sendButton.dataset.action, 'send');
  assert.match(fakeDocument.sendButton.textContent, /发送/);
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
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
        return jsonResponse({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          agentType: 'plan',
          sandboxMode: 'workspace-write',
        });
      }

      if (url === '/api/sessions/thread-2/settings') {
        return jsonResponse({
          model: null,
          reasoningEffort: null,
          agentType: null,
          sandboxMode: 'read-only',
        });
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
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="agent"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="sandbox"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary-icon="approval"/);
  assert.match(
    fakeDocument.approvalModeControls.innerHTML,
    /data-composer-settings-summary-item="agent"[\s\S]*data-composer-settings-summary-item="model"[\s\S]*data-composer-settings-summary-item="reasoning"[\s\S]*data-composer-settings-summary-item="sandbox"[\s\S]*data-composer-settings-summary-item="approval"/,
  );

  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'model', '模型');
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'reasoning', '推理强度');
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'agent', 'Agent 类型');
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'sandbox', '沙箱类型');
  assertComposerSetting(fakeDocument.approvalModeControls.innerHTML, 'approval', '审批模式');
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /工作区可写/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /data-composer-setting-value="model"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /data-composer-setting-value="reasoning"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /data-composer-setting-value="agent"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /data-composer-setting-value="sandbox"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /data-composer-setting-value="approval"/);
  assert.doesNotMatch(fakeDocument.approvalModeControls.innerHTML, /title="模型"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="模型：gpt-5\.4"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="Agent 类型：计划"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /aria-label="沙箱类型：工作区可写"/);

  app.toggleComposerSettings();
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="false"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-confirm="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, />确认<\/button>/);
  assert.match(
    fakeDocument.approvalModeControls.innerHTML,
    /data-composer-setting="agent"[\s\S]*data-composer-setting="model"[\s\S]*data-composer-setting="reasoning"[\s\S]*data-composer-setting="sandbox"[\s\S]*data-composer-setting="approval"/,
  );

  await app.selectSession('thread-2');

  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-collapsed="true"/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-model-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-reasoning-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-agent-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-session-sandbox-select="true"[^>]*disabled/);
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-approval-mode-select="true"[^>]*disabled/);
});

test('browser app keeps the compact settings strip stable during unrelated composer and status updates', async () => {
  const fakeDocument = createFakeDocument({ mobile: true });
  const settingsWrites = trackInnerHtmlWrites(fakeDocument.approvalModeControls);
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
            sandboxMode: 'danger-full-access',
          },
          runtimeContext: {
            sandboxMode: 'workspace-write',
          },
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          agentType: 'plan',
          sandboxMode: 'workspace-write',
        });
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

  const initialSettingsWrites = settingsWrites.count;
  assert.match(fakeDocument.approvalModeControls.innerHTML, /data-composer-settings-summary="true"/);

  app.setComposerDraft('keep the settings strip steady');
  assert.equal(settingsWrites.count, initialSettingsWrites);

  await app.loadStatus();
  assert.equal(settingsWrites.count, initialSettingsWrites);
});

test('browser app keeps the compact settings strip stable during runtime reconciliation refreshes', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument({ mobile: true });
  const settingsWrites = trackInnerHtmlWrites(fakeDocument.approvalModeControls);
  let detailReads = 0;
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
                  settings: {
                    model: 'gpt-5.4',
                    reasoningEffort: 'high',
                    agentType: 'plan',
                    sandboxMode: 'workspace-write',
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
            sandboxMode: 'danger-full-access',
          },
          runtimeContext: {
            sandboxMode: 'workspace-write',
          },
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          agentType: 'plan',
          sandboxMode: 'workspace-write',
        });
      }

      if (url === '/api/sessions/thread-1') {
        detailReads += 1;
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
            settings: {
              model: 'gpt-5.4',
              reasoningEffort: 'high',
              agentType: 'plan',
              sandboxMode: 'workspace-write',
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const initialSettingsWrites = settingsWrites.count;

  fakeEventSource.emit({
    type: 'session_runtime_reconciled',
    payload: {
      threadId: 'thread-1',
      runtime: {
        turnStatus: 'idle',
        activeTurnId: null,
        diff: null,
        realtime: { status: 'idle', sessionId: null, items: [] },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(detailReads, 2);
  assert.equal(settingsWrites.count, initialSettingsWrites);
});

test('browser app keeps the compact settings strip stable while realtime session updates stream in', async () => {
  const fakeEventSource = createFakeEventSource();
  const fakeDocument = createFakeDocument({ mobile: true });
  const settingsWrites = trackInnerHtmlWrites(fakeDocument.approvalModeControls);
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
                  runtime: {
                    turnStatus: 'started',
                    activeTurnId: 'turn-1',
                    diff: null,
                    realtime: {
                      status: 'started',
                      sessionId: 'rt-1',
                      items: [{ index: 1, summary: 'init', value: { type: 'init' } }],
                    },
                  },
                  settings: {
                    model: 'gpt-5.4',
                    reasoningEffort: 'high',
                    agentType: 'plan',
                    sandboxMode: 'workspace-write',
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
            sandboxMode: 'danger-full-access',
          },
          runtimeContext: {
            sandboxMode: 'workspace-write',
          },
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          agentType: 'plan',
          sandboxMode: 'workspace-write',
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-1',
              diff: null,
              realtime: {
                status: 'started',
                sessionId: 'rt-1',
                items: [{ index: 1, summary: 'init', value: { type: 'init' } }],
              },
            },
            settings: {
              model: 'gpt-5.4',
              reasoningEffort: 'high',
              agentType: 'plan',
              sandboxMode: 'workspace-write',
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const initialSettingsWrites = settingsWrites.count;

  fakeEventSource.emit({
    type: 'thread_realtime_item_added',
    payload: {
      threadId: 'thread-1',
      item: { type: 'progress', label: 'step-2' },
    },
  });

  assert.equal(settingsWrites.count, initialSettingsWrites);
});

test('browser app avoids rewriting stable header and composer chrome during status polling', async () => {
  const fakeDocument = createFakeDocument({ mobile: true });
  const fakeEventSource = createFakeEventSource();
  const conversationStatusWrites = trackPropertyWrites(fakeDocument.conversationStatus, 'innerHTML');
  const conversationTitleWrites = trackPropertyWrites(fakeDocument.conversationTitle, 'textContent');
  const composerPlaceholderWrites = trackPropertyWrites(fakeDocument.composerInput, 'placeholder');
  const layoutStyleWrites = trackStyleSetPropertyCalls(fakeDocument.appLayout.style);
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
                  runtime: {
                    turnStatus: 'started',
                    activeTurnId: 'turn-1',
                    diff: null,
                    realtime: {
                      status: 'started',
                      sessionId: 'rt-1',
                      items: [{ index: 1, summary: 'init', value: { type: 'init' } }],
                    },
                  },
                  settings: {
                    model: 'gpt-5.4',
                    reasoningEffort: 'high',
                    agentType: 'plan',
                    sandboxMode: 'workspace-write',
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
          agentTypeOptions: [
            { value: 'default', label: '执行' },
            { value: 'plan', label: '计划' },
          ],
          sandboxModeOptions: [
            { value: 'read-only', label: '只读' },
            { value: 'workspace-write', label: '工作区可写' },
            { value: 'danger-full-access', label: '完全访问' },
          ],
          defaults: {
            model: null,
            reasoningEffort: null,
            agentType: 'default',
            sandboxMode: 'danger-full-access',
          },
          runtimeContext: {
            sandboxMode: 'workspace-write',
          },
        });
      }

      if (url === '/api/approval-mode') {
        return jsonResponse({ mode: 'manual' });
      }

      if (url === '/api/sessions/thread-1/settings') {
        return jsonResponse({
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          agentType: 'plan',
          sandboxMode: 'workspace-write',
        });
      }

      if (url === '/api/sessions/thread-1') {
        return jsonResponse({
          thread: {
            id: 'thread-1',
            name: 'Running thread',
            cwd: '/tmp/workspace-a',
            runtime: {
              turnStatus: 'started',
              activeTurnId: 'turn-1',
              diff: null,
              realtime: {
                status: 'started',
                sessionId: 'rt-1',
                items: [{ index: 1, summary: 'init', value: { type: 'init' } }],
              },
            },
            settings: {
              model: 'gpt-5.4',
              reasoningEffort: 'high',
              agentType: 'plan',
              sandboxMode: 'workspace-write',
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
    eventSourceFactory: () => fakeEventSource,
    documentRef: fakeDocument,
    storageImpl: createFakeStorage(),
  });

  await app.loadSessions();
  await app.loadApprovalMode();
  await app.loadSessionOptions();
  await app.selectSession('thread-1');

  const initialConversationStatusWrites = conversationStatusWrites.count;
  const initialConversationTitleWrites = conversationTitleWrites.count;
  const initialComposerPlaceholderWrites = composerPlaceholderWrites.count;
  const initialLayoutStyleWrites = layoutStyleWrites.count;

  await app.loadStatus();

  assert.equal(conversationStatusWrites.count, initialConversationStatusWrites);
  assert.equal(conversationTitleWrites.count, initialConversationTitleWrites);
  assert.equal(composerPlaceholderWrites.count, initialComposerPlaceholderWrites);
  assert.equal(layoutStyleWrites.count, initialLayoutStyleWrites);

  fakeEventSource.emit({
    type: 'thread_realtime_item_added',
    payload: {
      threadId: 'thread-1',
      item: { type: 'progress', label: 'step-2' },
    },
  });

  assert.equal(conversationStatusWrites.count, initialConversationStatusWrites);
  assert.equal(conversationTitleWrites.count, initialConversationTitleWrites);
  assert.equal(composerPlaceholderWrites.count, initialComposerPlaceholderWrites);
  assert.equal(layoutStyleWrites.count, initialLayoutStyleWrites);
});
