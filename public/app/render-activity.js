import { escapeHtml, isAuthenticatedAppState } from './dom-utils.js';
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
  normalizeComposerAttachments,
  renderComposerAttachmentCard,
} from './session-utils.js';
import { renderParagraphList, renderTaskPlanStep } from './render-turn-items.js';

export function renderActivityPanel(state) {
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

  if (sendButton) {
    sendButton.textContent = primaryAction.label;
    sendButton.disabled = primaryAction.disabled;
    sendButton.title = primaryAction.title;
    if (sendButton.dataset) {
      sendButton.dataset.action = primaryAction.kind;
    }
  }

  if (interruptButton) {
    interruptButton.hidden = true;
    interruptButton.disabled = true;
    interruptButton.textContent = '中断';
    interruptButton.title = '中断当前回合';
    if (interruptButton.dataset) {
      interruptButton.dataset.interruptable = String(primaryAction.kind === 'interrupt');
    }
  }
}

export function resolveComposerPrimaryAction(state) {
  const sessionId = state.selectedSessionId;
  const status = sessionId ? state.turnStatusBySession[sessionId] ?? 'idle' : 'idle';

  if (canInterruptTurn(state)) {
    return {
      kind: 'interrupt',
      label: '停止',
      disabled: false,
      title: '停止当前回合',
    };
  }

  if (status === 'interrupting') {
    return {
      kind: 'interrupting',
      label: '停止中…',
      disabled: true,
      title: '正在停止当前回合',
    };
  }

  if (status === 'started') {
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

  composerInput.disabled = !isAuthenticatedAppState(state);
  composerInput.placeholder = isAuthenticatedAppState(state)
    ? '输入下一步请求'
    : '请输入共享密码后再继续';
  syncComposerInputHeight(composerInput);
}

export function syncComposerInputHeight(composerInput) {
  if (!composerInput?.style) {
    return;
  }

  const minHeight = 52;
  const maxHeight = 148;
  const scrollHeight = Number(composerInput.scrollHeight ?? 0);
  const resolvedHeight = Math.min(maxHeight, Math.max(minHeight, scrollHeight || minHeight));

  composerInput.style.height = `${resolvedHeight}px`;
  composerInput.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
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
  container.hidden = !message;
  container.textContent = message ?? '';
}

export function syncComposerInlineFeedback(container, state) {
  if (!container) {
    return;
  }

  const message = resolveComposerInlineFeedback(state);
  container.hidden = !message;
  container.textContent = message ?? '';
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
    fileButton.disabled = disabled;
    fileButton.hidden = false;
    fileButton.textContent = '+';
    fileButton.title = '添加附件';
    fileButton.setAttribute?.('aria-expanded', String(menuOpen));
  }

  if (fileActionButton) {
    fileActionButton.disabled = disabled;
    fileActionButton.hidden = !menuOpen;
    fileActionButton.textContent = '上传文件';
  }

  if (imageButton) {
    imageButton.disabled = disabled;
    imageButton.hidden = !menuOpen;
    imageButton.textContent = '上传图片';
  }

  if (menu) {
    menu.hidden = !menuOpen;
  }

  for (const element of [fileInput, imageInput]) {
    if (element) {
      element.disabled = disabled;
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
