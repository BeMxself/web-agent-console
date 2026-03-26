import { escapeHtml, isAuthenticatedAppState, normalizeActivityPanelTab } from './dom-utils.js';
import { findThreadMeta, getPendingSessionProject } from './project-utils.js';
import { extractLatestTurnPlan } from './plan-utils.js';
import {
  formatRealtimeAudioSummary,
  hasRealtimeSessionData,
  normalizeRealtimeSessionState,
} from './thread-utils.js';
import {
  canInterruptTurn,
  canSendTurn,
  getComposerAttachmentError,
  isSessionActivelyRunning,
  normalizeComposerAttachments,
  renderComposerAttachmentCard,
  supportsLiveTurnFollowUp,
} from './session-utils.js';
import { renderParagraphList, renderTaskPlanStep } from './render-turn-items.js';

export function renderActivityPanel(state) {
  const activeTab = normalizeActivityPanelTab(state.activityPanelTab);
  const body =
    activeTab === 'files'
      ? renderWorkspaceFileBrowserPanel(state)
      : renderActivityStatusPanel(state);

  return [
    '<div class="activity-panel-shell">',
    '<div class="activity-panel-tablist" role="tablist" aria-label="右侧栏视图">',
    renderActivityPanelTab('activity', '活动', activeTab),
    renderActivityPanelTab('files', '文件', activeTab),
    '</div>',
    `<div class="activity-panel-body">${body}</div>`,
    '</div>',
  ].join('');
}

export function renderActivityPanelTab(value, label, activeTab) {
  const selected = value === activeTab;
  return [
    `<button class="activity-panel-tab${selected ? ' activity-panel-tab--selected' : ''}" type="button" role="tab" aria-selected="${String(selected)}" data-activity-panel-tab="${value}">`,
    escapeHtml(label),
    '</button>',
  ].join('');
}

export function renderActivityStatusPanel(state) {
  const pendingProject = getPendingSessionProject(state);
  if (pendingProject) {
    return renderActivitySplitLayout({
      activityBody: `<p>将在 ${escapeHtml(pendingProject.displayName ?? pendingProject.cwd ?? '当前项目')} 发送第一条消息后创建会话。</p>`,
      tasksBody: '<p class="activity-empty">发送第一条消息后，这里会同步展示任务列表。</p>',
    });
  }

  if (!state.selectedSessionId) {
    return renderActivitySplitLayout({
      activityBody: '<p>选择会话后，这里会显示当前 turn 状态和 diff。</p>',
      tasksBody: '<p class="activity-empty">选择会话后，这里会显示当前任务列表。</p>',
    });
  }

  const selectedDetail = state.sessionDetailsById[state.selectedSessionId] ?? null;
  const status = state.turnStatusBySession[state.selectedSessionId] ?? 'idle';
  const diff = state.diffBySession[state.selectedSessionId];
  const realtime = normalizeRealtimeSessionState(state.realtimeBySession[state.selectedSessionId]);

  return renderActivitySplitLayout({
    activityBody: [
      `<div class="meta-chip">${escapeHtml(status)}</div>`,
      renderActivityRealtime(realtime),
      diff
        ? `<pre class="diff-view">${escapeHtml(diff)}</pre>`
        : '<p class="activity-empty">这个会话还没有 diff 事件。</p>',
    ].join(''),
    tasksBody: renderTaskListPanel(selectedDetail),
  });
}

export function renderWorkspaceFileBrowserPanel(state) {
  const session =
    state.sessionDetailsById?.[state.selectedSessionId] ??
    findThreadMeta(state.projects ?? [], state.selectedSessionId);
  const cwd = String(session?.cwd ?? '').trim();

  if (getPendingSessionProject(state)) {
    return renderActivitySplitSection({
      title: '工作区文件',
      className: 'activity-split-section activity-split-section--files',
      body: '<p class="activity-empty">发送第一条消息后，才能浏览当前工作区文件。</p>',
    });
  }

  if (!state.selectedSessionId || !cwd) {
    return renderActivitySplitSection({
      title: '工作区文件',
      className: 'activity-split-section activity-split-section--files',
      body: '<p class="activity-empty">选择会话后，这里会显示当前工作区文件。</p>',
    });
  }

  const fileBrowser = state.fileBrowser ?? {};
  const rootPath = String(fileBrowser.rootPath ?? cwd).trim() || cwd;
  const currentPath = String(fileBrowser.currentPath ?? rootPath).trim() || rootPath;
  const showParentButton =
    Boolean(fileBrowser.parentPath) && currentPath !== rootPath;

  let body = '';
  if (fileBrowser.loading) {
    body = '<p class="activity-empty">正在加载工作区文件…</p>';
  } else if (fileBrowser.error) {
    body = `<p class="file-browser-error">${escapeHtml(fileBrowser.error)}</p>`;
  } else if ((fileBrowser.entries ?? []).length) {
    body = [
      '<div class="file-browser-list" role="list">',
      fileBrowser.entries.map((entry) => renderFileBrowserEntry(entry)).join(''),
      '</div>',
    ].join('');
  } else {
    body = '<p class="activity-empty">这个目录里还没有可显示的文件。</p>';
  }

  return renderActivitySplitSection({
    title: '工作区文件',
    className: 'activity-split-section activity-split-section--files',
    body: [
      '<div class="file-browser-meta">',
      `<div class="file-browser-meta-label">根目录</div><div class="file-browser-meta-value">${escapeHtml(rootPath)}</div>`,
      `<div class="file-browser-meta-label">当前目录</div><div class="file-browser-meta-value">${escapeHtml(currentPath)}</div>`,
      '</div>',
      showParentButton
        ? `<button class="file-browser-parent" type="button" data-file-browser-parent-path="${escapeHtml(fileBrowser.parentPath)}">返回上级目录</button>`
        : '',
      body,
    ]
      .filter(Boolean)
      .join(''),
  });
}

export function renderFileBrowserEntry(entry) {
  const kindLabel = entry.kind === 'directory' ? '目录' : '文件';
  return [
    '<div class="file-browser-list-item" role="listitem">',
    `<button class="file-browser-entry file-browser-entry--${escapeHtml(entry.kind)}" type="button" data-file-browser-entry-path="${escapeHtml(entry.path)}" data-file-browser-entry-kind="${escapeHtml(entry.kind)}">`,
    `<span class="file-browser-entry-kind">${escapeHtml(kindLabel)}</span>`,
    `<span class="file-browser-entry-name">${escapeHtml(entry.name)}</span>`,
    entry.kind === 'file' && entry.mimeType
      ? `<span class="file-browser-entry-meta">${escapeHtml(entry.mimeType)}</span>`
      : '',
    '</button>',
    '</div>',
  ].join('');
}

export function renderActivityRealtime(realtime) {
  if (!hasRealtimeSessionData(realtime)) {
    return '<p class="activity-empty">这个会话还没有 realtime 事件。</p>';
  }

  const latestItem = realtime.items.at(-1) ?? null;

  return [
    '<section class="activity-realtime">',
    '<div class="activity-realtime-header">',
    '<div class="activity-realtime-title">实时流</div>',
    `<span class="meta-chip">${escapeHtml(realtime.status)}</span>`,
    '</div>',
    '<div class="activity-realtime-body">',
    realtime.sessionId
      ? `<p class="activity-realtime-line"><strong>Session:</strong> ${escapeHtml(realtime.sessionId)}</p>`
      : '',
    latestItem
      ? `<p class="activity-realtime-line"><strong>Latest:</strong> #${latestItem.index} ${escapeHtml(latestItem.summary)}</p>`
      : '',
    realtime.audioChunkCount > 0
      ? `<p class="activity-realtime-line"><strong>Audio:</strong> ${escapeHtml(formatRealtimeAudioSummary(realtime))}</p>`
      : '',
    realtime.lastError
      ? `<p class="activity-realtime-line"><strong>Error:</strong> ${escapeHtml(realtime.lastError)}</p>`
      : '',
    realtime.closeReason
      ? `<p class="activity-realtime-line"><strong>Closed:</strong> ${escapeHtml(realtime.closeReason)}</p>`
      : '',
    '</div>',
    '</section>',
  ].join('');
}

export function renderActivitySplitLayout({ activityBody, tasksBody }) {
  return [
    '<div class="activity-split-layout">',
    renderActivitySplitSection({
      title: '活动',
      body: activityBody,
      className: 'activity-split-section activity-split-section--activity',
    }),
    renderActivitySplitSection({
      title: '任务列表',
      body: tasksBody,
      className: 'activity-split-section activity-split-section--tasks',
    }),
    '</div>',
  ].join('');
}

export function renderActivitySplitSection({ title, body, className = 'activity-split-section' }) {
  return [
    `<section class="${className}">`,
    '<div class="activity-card activity-split-card">',
    `<div class="activity-split-header"><h2>${escapeHtml(title)}</h2></div>`,
    `<div class="activity-split-body">${body}</div>`,
    '</div>',
    '</section>',
  ].join('');
}

export function renderTaskListPanel(session) {
  const latestPlan = extractLatestTurnPlan(session);
  if (!latestPlan) {
    return '<p class="activity-empty">这个会话还没有任务计划。</p>';
  }

  const stepMarkup = latestPlan.steps.length
    ? [
        '<div class="task-plan-list" role="list">',
        latestPlan.steps
          .map((step, index) => renderTaskPlanStep(step, index))
          .join(''),
        '</div>',
      ].join('')
    : '';
  const textMarkup =
    !latestPlan.steps.length && latestPlan.text
      ? renderParagraphList(splitMultilineText(latestPlan.text))
      : '';

  return [
    latestPlan.explanation
      ? `<p class="task-plan-explanation">${escapeHtml(latestPlan.explanation)}</p>`
      : '',
    stepMarkup,
    textMarkup,
  ]
    .filter(Boolean)
    .join('');
}


export function syncTaskSummaryBand(node, session, state, mobileViewport = false) {
  if (!node) {
    return;
  }

  if (!session && !state.pendingSessionProjectId) {
    node.hidden = true;
    node.innerHTML = '';
    return;
  }

  const markup = renderTaskSummaryBand(session, state, { mobileViewport });
  node.hidden = !markup;
  node.innerHTML = markup;
}

export function renderTaskSummaryBand(session, state, { mobileViewport = false } = {}) {
  const summary = summarizeLatestPlan(session);
  if (!summary) {
    return '';
  }

  const collapsed = isTaskSummaryCollapsed(state, session?.id, mobileViewport);
  return [
    `<section class="task-summary-band" data-task-summary-collapsed="${String(collapsed)}">`,
    '<div class="task-summary-band-header">',
    `<div class="task-summary-band-title">已完成 ${summary.completedCount} 个任务（共 ${summary.total} 个）</div>`,
    `<button class="task-summary-band-toggle" type="button" data-task-summary-toggle="true" data-task-summary-session-id="${escapeHtml(session?.id ?? '')}" aria-expanded="${String(!collapsed)}">`,
    collapsed ? '展开任务概览' : '收起任务概览',
    '</button>',
    '</div>',
    summary.explanation
      ? `<p class="task-summary-band-explanation">${escapeHtml(summary.explanation)}</p>`
      : '',
    collapsed ? '' : renderTaskSummaryBreakdown(summary),
    '</section>',
  ].join('');
}

export function renderTaskSummaryBreakdown(summary) {
  return [
    '<div class="task-summary-breakdown" data-task-summary-breakdown="true">',
    renderTaskSummaryGroup('completed', '已完成', summary.completedPreview),
    renderTaskSummaryGroup('running', '进行中', summary.runningPreview),
    renderTaskSummaryGroup('upcoming', '即将开始', summary.upcomingPreview),
    '</div>',
  ].join('');
}

export function renderTaskSummaryGroup(group, title, items) {
  if (!items.length) {
    return '';
  }

  return [
    `<section class="task-summary-group task-summary-group--${group}" data-task-summary-group="${group}">`,
    `<div class="task-summary-group-title">${escapeHtml(title)}</div>`,
    '<div class="task-summary-group-list">',
    items.map((item) => renderTaskSummaryItem(group, item)).join(''),
    '</div>',
    '</section>',
  ].join('');
}

export function renderTaskSummaryItem(group, item) {
  return [
    `<div class="task-summary-item task-summary-item--${group}" data-task-summary-item-group="${group}">`,
    escapeHtml(item.step),
    '</div>',
  ].join('');
}

export function summarizeLatestPlan(session) {
  const latestPlan = extractLatestTurnPlan(session);
  if (!latestPlan) {
    return null;
  }

  const steps = latestPlan.steps ?? [];
  const completed = steps.filter((step) => step.status === 'completed');
  const running = steps.filter((step) => step.status === 'inProgress');
  const upcoming = steps.filter((step) => step.status !== 'completed' && step.status !== 'inProgress');

  return {
    total: steps.length,
    explanation: latestPlan.explanation ?? null,
    completedCount: completed.length,
    completedPreview: completed.slice(-2),
    runningPreview: running.slice(0, 1),
    upcomingPreview: upcoming.slice(0, 2),
  };
}

export function isTaskSummaryCollapsed(state, sessionId, mobileViewport = false) {
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (!normalizedSessionId) {
    return Boolean(mobileViewport);
  }

  const explicitState = state?.taskSummaryCollapsedBySession?.[normalizedSessionId];
  if (typeof explicitState === 'boolean') {
    return explicitState;
  }

  return Boolean(mobileViewport);
}

export function getComposerSettingsScopeId(state) {
  const selectedSessionId = String(state?.selectedSessionId ?? '').trim();
  if (selectedSessionId) {
    return `session:${selectedSessionId}`;
  }

  const pendingProjectId = String(state?.pendingSessionProjectId ?? '').trim();
  if (pendingProjectId) {
    return `project:${pendingProjectId}`;
  }

  return 'global';
}

export function isComposerSettingsCollapsed(state, scopeId = getComposerSettingsScopeId(state), mobileViewport = false) {
  const normalizedScopeId = String(scopeId ?? '').trim();
  if (!normalizedScopeId) {
    return true;
  }

  const explicitState = state?.composerSettingsCollapsedByScope?.[normalizedScopeId];
  if (typeof explicitState === 'boolean') {
    return explicitState;
  }

  return true;
}

export function syncComposerButtons(sendButton, interruptButton, state) {
  const primaryAction = resolveComposerPrimaryAction(state);
  const sessionId = state.selectedSessionId;
  const status = sessionId ? state.turnStatusBySession[sessionId] ?? 'idle' : 'idle';

  if (sendButton) {
    if (sendButton.textContent !== primaryAction.label) {
      sendButton.textContent = primaryAction.label;
    }
    if (sendButton.disabled !== primaryAction.disabled) {
      sendButton.disabled = primaryAction.disabled;
    }
    if (sendButton.title !== primaryAction.title) {
      sendButton.title = primaryAction.title;
    }
    if (sendButton.dataset) {
      if (sendButton.dataset.action !== primaryAction.kind) {
        sendButton.dataset.action = primaryAction.kind;
      }
    }
  }

  if (interruptButton) {
    const nextHidden = !(canInterruptTurn(state) || status === 'interrupting');
    if (interruptButton.hidden !== nextHidden) {
      interruptButton.hidden = nextHidden;
    }
    const nextDisabled = status === 'interrupting' || !canInterruptTurn(state);
    if (interruptButton.disabled !== nextDisabled) {
      interruptButton.disabled = nextDisabled;
    }
    const nextText = status === 'interrupting' ? '停止中…' : '中断';
    if (interruptButton.textContent !== nextText) {
      interruptButton.textContent = nextText;
    }
    const nextTitle = status === 'interrupting' ? '正在停止当前回合' : '中断当前回合';
    if (interruptButton.title !== nextTitle) {
      interruptButton.title = nextTitle;
    }
    if (interruptButton.dataset) {
      const nextAction = status === 'interrupting' ? 'interrupting' : 'interrupt';
      if (interruptButton.dataset.action !== nextAction) {
        interruptButton.dataset.action = nextAction;
      }
    }
  }
}

export function resolveComposerPrimaryAction(state) {
  const sessionId = state.selectedSessionId;
  const status = sessionId ? state.turnStatusBySession[sessionId] ?? 'idle' : 'idle';
  const liveFollowUp = supportsLiveTurnFollowUp(state);
  const activeLike = isSessionActivelyRunning(state, sessionId);

  if (status === 'interrupting') {
    return {
      kind: 'send',
      label: '发送',
      disabled: true,
      title: '正在停止当前回合',
    };
  }

  if (activeLike) {
    if (liveFollowUp) {
      const sendable = canSendTurn(state);
      return {
        kind: 'send',
        label: '发送',
        disabled: !sendable,
        title: sendable ? '继续向当前会话发送输入' : '当前回合执行中，输入后可继续发送',
      };
    }
    return {
      kind: 'busy',
      label: '执行中…',
      disabled: true,
      title: '当前回合正在执行',
    };
  }

  const sendable = canSendTurn(state);
  return {
    kind: 'send',
    label: '发送',
    disabled: !sendable,
    title: sendable ? '发送当前输入' : '当前还不能发送',
  };
}

export function syncComposerInput(composerInput, state) {
  if (!composerInput) {
    return;
  }

  if (composerInput.value !== state.composerDraft) {
    composerInput.value = state.composerDraft;
  }

  const nextDisabled = !isAuthenticatedAppState(state);
  if (composerInput.disabled !== nextDisabled) {
    composerInput.disabled = nextDisabled;
  }
  const nextPlaceholder = isAuthenticatedAppState(state)
    ? '输入下一步请求'
    : '请输入共享密码后再继续';
  if (composerInput.placeholder !== nextPlaceholder) {
    composerInput.placeholder = nextPlaceholder;
  }
  syncComposerInputHeight(composerInput);
}

export function syncComposerInputHeight(composerInput) {
  if (!composerInput?.style) {
    return;
  }

  const minHeight = 52;
  const maxHeight = 148;
  const resetHeight = `${minHeight}px`;
  if (composerInput.style.height !== resetHeight) {
    composerInput.style.height = resetHeight;
  }
  const scrollHeight = Number(composerInput.scrollHeight ?? 0);
  const resolvedHeight = Math.min(maxHeight, Math.max(minHeight, scrollHeight || minHeight));
  const nextHeight = `${resolvedHeight}px`;
  if (composerInput.style.height !== nextHeight) {
    composerInput.style.height = nextHeight;
  }
  const nextOverflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  if (composerInput.style.overflowY !== nextOverflowY) {
    composerInput.style.overflowY = nextOverflowY;
  }
}

export function syncComposerAttachmentsStrip(container, state) {
  if (!container) {
    return;
  }

  const attachments = normalizeComposerAttachments(state.composerAttachments);
  if (attachments.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = [
    '<div class="composer-attachment-strip" role="list">',
    attachments.map((attachment) => renderComposerAttachmentCard(attachment)).join(''),
    '</div>',
  ].join('');
}

export function syncComposerAttachmentError(container, state) {
  if (!container) {
    return;
  }

  const message = getComposerAttachmentError(state);
  const nextHidden = !message;
  if (container.hidden !== nextHidden) {
    container.hidden = nextHidden;
  }
  const nextMessage = message ?? '';
  if (container.textContent !== nextMessage) {
    container.textContent = nextMessage;
  }
}

export function syncComposerInlineFeedback(container, state) {
  if (!container) {
    return;
  }

  const message = resolveComposerInlineFeedback(state);
  const nextHidden = !message;
  if (container.hidden !== nextHidden) {
    container.hidden = nextHidden;
  }
  const nextMessage = message ?? '';
  if (container.textContent !== nextMessage) {
    container.textContent = nextMessage;
  }
}

export function resolveComposerInlineFeedback(state) {
  if (!isAuthenticatedAppState(state)) {
    return '登录后即可继续发送。';
  }

  const sessionId = String(state?.selectedSessionId ?? '').trim();
  const sessionMeta = sessionId
    ? state?.sessionDetailsById?.[sessionId] ?? findThreadMeta(state?.projects ?? [], sessionId)
    : null;
  const pendingApprovalCount = Number(
    sessionMeta?.pendingApprovalCount ?? 0,
  );
  if (sessionMeta?.waitingOnApproval || pendingApprovalCount > 0) {
    return '等待审批后可继续发送';
  }

  const pendingQuestionCount = Number(
    sessionMeta?.pendingQuestionCount ?? 0,
  );
  if (sessionMeta?.waitingOnQuestion || pendingQuestionCount > 0) {
    return '等待回答当前问题后可继续发送';
  }

  return null;
}

export function syncComposerAttachmentActions(
  fileButton,
  fileActionButton,
  imageButton,
  menu,
  fileInput,
  imageInput,
  state,
) {
  const disabled = !isAuthenticatedAppState(state);
  const menuOpen = !disabled && state.composerAttachmentMenuOpen === true;

  if (fileButton) {
    if (fileButton.disabled !== disabled) {
      fileButton.disabled = disabled;
    }
    if (fileButton.hidden) {
      fileButton.hidden = false;
    }
    if (fileButton.textContent !== '+') {
      fileButton.textContent = '+';
    }
    if (fileButton.title !== '添加附件') {
      fileButton.title = '添加附件';
    }
    const nextExpanded = String(menuOpen);
    if (fileButton.getAttribute?.('aria-expanded') !== nextExpanded) {
      fileButton.setAttribute?.('aria-expanded', nextExpanded);
    }
  }

  if (fileActionButton) {
    if (fileActionButton.disabled !== disabled) {
      fileActionButton.disabled = disabled;
    }
    const nextHidden = !menuOpen;
    if (fileActionButton.hidden !== nextHidden) {
      fileActionButton.hidden = nextHidden;
    }
    if (fileActionButton.textContent !== '上传文件') {
      fileActionButton.textContent = '上传文件';
    }
  }

  if (imageButton) {
    if (imageButton.disabled !== disabled) {
      imageButton.disabled = disabled;
    }
    const nextHidden = !menuOpen;
    if (imageButton.hidden !== nextHidden) {
      imageButton.hidden = nextHidden;
    }
    if (imageButton.textContent !== '上传图片') {
      imageButton.textContent = '上传图片';
    }
  }

  if (menu) {
    const nextHidden = !menuOpen;
    if (menu.hidden !== nextHidden) {
      menu.hidden = nextHidden;
    }
  }

  for (const element of [fileInput, imageInput]) {
    if (element) {
      if (element.disabled !== disabled) {
        element.disabled = disabled;
      }
    }
  }
}

export function getSessionSignal(state, sessionId, isSelected) {
  const sessionMeta = findThreadMeta(state.projects ?? [], sessionId);
  const status = state.turnStatusBySession?.[sessionId] ?? 'idle';
  const realtime = normalizeRealtimeSessionState(state.realtimeBySession?.[sessionId]);
  if (status === 'started' || status === 'interrupting' || realtime.status === 'started') {
    return {
      kind: 'busy',
      label: status === 'interrupting' ? '中断中' : '执行中',
    };
  }

  const pendingApprovalCount = Number(
    state.sessionDetailsById?.[sessionId]?.pendingApprovalCount ??
      sessionMeta?.pendingApprovalCount ??
      0,
  );
  const waitingOnApproval = Boolean(
    state.sessionDetailsById?.[sessionId]?.waitingOnApproval ??
      sessionMeta?.waitingOnApproval,
  );
  if (pendingApprovalCount > 0 || waitingOnApproval) {
    return {
      kind: 'approval',
      label: pendingApprovalCount > 0 ? `等待审批 ${pendingApprovalCount}` : '等待审批',
    };
  }

  const pendingQuestionCount = Number(
    state.sessionDetailsById?.[sessionId]?.pendingQuestionCount ??
      sessionMeta?.pendingQuestionCount ??
      0,
  );
  const waitingOnQuestion = Boolean(
    state.sessionDetailsById?.[sessionId]?.waitingOnQuestion ??
      sessionMeta?.waitingOnQuestion,
  );
  if (pendingQuestionCount > 0 || waitingOnQuestion) {
    return {
      kind: 'question',
      label: pendingQuestionCount > 0 ? `等待回复 ${pendingQuestionCount}` : '等待回复',
    };
  }

  const unreadCount = Number(state.unreadBySession?.[sessionId] ?? 0);
  if (!isSelected && unreadCount > 0) {
    return {
      kind: 'unread',
      label: '有未读更新',
    };
  }

  return null;
}
