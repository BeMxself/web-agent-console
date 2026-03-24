import { escapeHtml } from './dom-utils.js';
import { getThreadSubtitle, getThreadTitle } from './project-utils.js';
import { formatTimestamp } from './session-utils.js';
import { getSessionSignal } from './render-activity.js';
import { normalizeExternalBridgeMode } from './thread-utils.js';

export function renderProjectGroup(project, state) {
  const projectId = project.id ?? project.cwd ?? '__unknown__';
  const focusedSessions = project.focusedSessions ?? [];

  return [
    '<section class="project-group">',
    '<header class="project-group-header">',
    '<div class="project-header-row">',
    `<button class="project-toggle" data-project-collapse="${escapeHtml(projectId)}" aria-expanded="${String(!project.collapsed)}">`,
    `<span class="project-chevron">${project.collapsed ? '▸' : '▾'}</span>`,
    `<span class="project-name">${escapeHtml(project.displayName ?? project.cwd ?? 'Unknown Workspace')}</span>`,
    `<span class="project-count">${focusedSessions.length}</span>`,
    '</button>',
    '<div class="project-action-group">',
    renderProjectActionButton({
      projectId,
      action: 'start',
      label: '新会话',
      tone: 'primary',
      icon: renderProjectActionIcon('start'),
      dataAttribute: 'data-project-session-start',
    }),
    renderProjectActionButton({
      projectId,
      action: 'history',
      label: '添加历史会话',
      tone: 'secondary',
      icon: renderProjectActionIcon('history'),
      dataAttribute: 'data-project-history-open',
    }),
    `<button class="project-close" type="button" data-project-close="${escapeHtml(projectId)}" aria-label="关闭项目" title="关闭项目">×</button>`,
    '</div>',
    '</div>',
    '</header>',
    project.collapsed
      ? ''
      : [
          '<div class="project-body">',
          renderFocusedSessions(project, state.selectedSessionId, state),
          '</div>',
        ].join(''),
    '</section>',
  ].join('');
}

export function renderProjectActionButton({ projectId, action, label, tone, icon, dataAttribute }) {
  return [
    `<button class="project-action project-action--icon project-action--${escapeHtml(tone)}" type="button" ${dataAttribute}="${escapeHtml(projectId)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" data-project-action="${escapeHtml(action)}">`,
    icon,
    '</button>',
  ].join('');
}

export function renderProjectActionIcon(kind) {
  if (kind === 'history') {
    return [
      '<span class="project-action-icon" aria-hidden="true">',
      '<svg viewBox="0 0 16 16" focusable="false">',
      '<path d="M8 3.2a4.8 4.8 0 1 1-3.64 1.67" />',
      '<path d="M4.36 2.9v2.6H1.8" />',
      '<path d="M8 5.35V8l1.9 1.32" />',
      '</svg>',
      '</span>',
    ].join('');
  }

  return [
    '<span class="project-action-icon" aria-hidden="true">',
    '<svg viewBox="0 0 16 16" focusable="false">',
    '<path d="M8 3.1v9.8" />',
    '<path d="M3.1 8h9.8" />',
    '</svg>',
    '</span>',
  ].join('');
}

export function renderFocusedSessions(project, selectedSessionId, state) {
  const projectId = project.id ?? project.cwd ?? '__unknown__';
  const sessions = project.focusedSessions ?? [];
  const pendingItem =
    state.pendingSessionProjectId === projectId
      ? renderPendingSessionItem(project)
      : '';

  if (!sessions.length && !pendingItem) {
    return '<div class="empty-list">暂无关注会话</div>';
  }

  return [
    pendingItem,
    sessions
      .map((session) => renderFocusedSessionItem(projectId, session, selectedSessionId, state))
      .join(''),
  ]
    .filter(Boolean)
    .join('');
}

export function renderFocusedSessionItem(projectId, session, selectedSessionId, state) {
  const selected = session.id === selectedSessionId ? ' aria-current="true"' : '';
  const sessionSignal = getSessionSignal(state, session.id, session.id === selectedSessionId);

  return [
    '<div class="focused-session-row">',
    '<div class="session-swipe-lane">',
    `<button class="session-item session-item--focused" data-session-id="${escapeHtml(session.id)}"${selected}>`,
    renderSessionItemBody(session, { signal: sessionSignal, showSubtitle: false }),
    '</button>',
    `<button class="focus-remove focus-remove--embedded" type="button" data-project-id="${escapeHtml(projectId)}" data-focused-remove="${escapeHtml(session.id)}" aria-label="移出关注">×</button>`,
    '</div>',
    '</div>',
  ].join('');
}

export function renderPendingSessionItem(project) {
  return [
    '<div class="focused-session-row focused-session-row--draft">',
    '<div class="session-swipe-lane">',
    '<div class="session-item session-item--draft" aria-current="true">',
    renderSessionItemBody(
      {
        id: `draft:${project.id ?? project.cwd ?? '__unknown__'}`,
        name: '新会话',
        preview: '发送第一条消息后创建',
      },
      {
        signal: null,
        showSubtitle: false,
      },
    ),
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

export function renderHistoryDialogContent(project, activeTab = 'active') {
  return [
    '<div class="history-dialog-shell">',
    '<div class="history-dialog-header">',
    '<div>',
    '<div class="history-dialog-eyebrow">添加历史会话</div>',
    `<h2 class="history-dialog-title">${escapeHtml(project.displayName ?? project.cwd ?? 'Unknown Workspace')}</h2>`,
    '</div>',
    '<button class="history-dialog-close" type="button" data-history-dialog-close="true" aria-label="关闭">×</button>',
    '</div>',
    renderHistoryDialogTabs(activeTab),
    '<div class="history-picker">',
    activeTab === 'archived'
      ? renderHistorySection(
          project.id ?? project.cwd ?? '__unknown__',
          project.historySessions?.archived ?? [],
          'archived',
        )
      : renderHistorySection(
          project.id ?? project.cwd ?? '__unknown__',
          project.historySessions?.active ?? [],
          'active',
        ),
    '</div>',
    '</div>',
  ].join('');
}

export function renderHistoryDialogTabs(activeTab) {
  return [
    '<div class="history-dialog-tabs" role="tablist" aria-label="历史会话分类">',
    renderHistoryDialogTab('active', '未归档', activeTab),
    renderHistoryDialogTab('archived', '已归档', activeTab),
    '</div>',
  ].join('');
}

export function renderHistoryDialogTab(value, label, activeTab) {
  const selected = value === activeTab;
  return [
    `<button class="history-dialog-tab${selected ? ' history-dialog-tab--selected' : ''}" type="button" role="tab" aria-selected="${String(selected)}" data-history-dialog-tab="${value}">`,
    escapeHtml(label),
    '</button>',
  ].join('');
}

export function renderHistorySection(projectId, sessions, sectionKind) {
  const items = sessions.length
    ? sessions.map((session) => renderHistoryItem(projectId, session, sectionKind)).join('')
    : '<div class="empty-list">暂时没有可导入的会话</div>';

  return ['<section class="history-section">', items, '</section>'].join('');
}

export function renderHistoryItem(projectId, session, sectionKind) {
  const buttonClass = [
    'session-item',
    'session-item--history',
    sectionKind === 'archived' ? 'session-item--archived' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    `<button class="${buttonClass}" type="button" data-project-id="${escapeHtml(projectId)}" data-project-history-add="${escapeHtml(session.id)}">`,
    renderSessionItemBody(session, {
      includeSignalPlaceholder: false,
      titleRowClass: 'session-item-title-row history-item-title-row',
    }),
    '</button>',
  ].join('');
}

export function renderSessionItemBody(
  session,
  {
    signal = null,
    showSubtitle = true,
    includeSignalPlaceholder = true,
    titleRowClass = 'session-item-title-row',
  } = {},
) {
  const subtitle = showSubtitle ? getThreadSubtitle(session) : null;
  return [
    '<span class="session-item-inner">',
    `<span class="${escapeHtml(titleRowClass)}">`,
    renderSessionSignal(signal, { includePlaceholder: includeSignalPlaceholder }),
    `<span class="session-title">${escapeHtml(getThreadTitle(session))}</span>`,
    renderExternalSessionBadge(session),
    '</span>',
    subtitle
      ? `<span class="session-item-subtitle">${escapeHtml(subtitle)}</span>`
      : '',
    '</span>',
  ].join('');
}

export function renderExternalSessionBadge(session, { variant = 'session' } = {}) {
  const badge = getExternalSessionBadge(session);
  if (!badge) {
    return '';
  }

  const className =
    variant === 'meta'
      ? `meta-chip meta-chip--external meta-chip--${badge.tone}`
      : `session-external-badge session-external-badge--${badge.tone}`;
  return `<span class="${className}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>`;
}

export function getExternalSessionBadge(session) {
  const external = session?.external;
  const bridgeMode = normalizeExternalBridgeMode(external?.bridgeMode);
  if (!bridgeMode) {
    return null;
  }

  if (bridgeMode === 'discovered') {
    return {
      tone: 'discovered',
      label: '已发现',
      title: '独立 Claude 会话已发现',
    };
  }

  if (bridgeMode === 'hooked') {
    if (isActiveExternalRuntime(session?.runtime)) {
      return {
        tone: 'hooked',
        label: '外部运行中',
        title: '独立 Claude 会话正在外部继续运行',
      };
    }
    return {
      tone: 'hooked',
      label: '已接管',
      title: '独立 Claude 会话已接入运行桥',
    };
  }

  if (isActiveExternalRuntime(session?.runtime)) {
    return {
      tone: 'hooked',
      label: '外部运行中',
      title: '独立 Claude 会话正在外部继续运行并同步转录进度',
    };
  }

  return {
    tone: 'hooked',
    label: '已跟踪',
    title: '独立 Claude 会话已接入运行桥并开启转录跟踪',
  };
}

export function renderSessionSignal(signal, { includePlaceholder = false } = {}) {
  if (!signal) {
    return includePlaceholder
      ? '<span class="session-status-indicator session-status-indicator--placeholder" aria-hidden="true"></span>'
      : '';
  }

  if (signal.kind === 'busy') {
    return `<span class="session-status-indicator session-status-indicator--busy" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  if (signal.kind === 'unread') {
    return `<span class="session-status-indicator session-status-indicator--unread" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  if (signal.kind === 'approval') {
    return `<span class="session-status-indicator session-status-indicator--approval" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  if (signal.kind === 'question') {
    return `<span class="session-status-indicator session-status-indicator--question" title="${escapeHtml(signal.label)}" aria-label="${escapeHtml(signal.label)}"></span>`;
  }

  return '';
}

export function isActiveExternalRuntime(runtime) {
  return Boolean(
    runtime?.turnStatus === 'started' ||
      runtime?.turnStatus === 'interrupting' ||
      runtime?.activeTurnId ||
      runtime?.realtime?.status === 'started',
  );
}
