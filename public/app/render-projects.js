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

export function renderProjectDialogContent(state) {
  const dialogState = state.projectDialog;
  if (!dialogState) {
    return '';
  }

  const activeTab = dialogState.tab === 'manual' ? 'manual' : 'browse';
  return [
    '<form id="project-dialog-form" class="project-dialog-shell project-dialog-browser-shell">',
    '<div class="dialog-header project-dialog-browser-header">',
    '<div class="dialog-eyebrow">添加项目</div>',
    '<button class="history-dialog-close" type="button" data-project-dialog-close="true" aria-label="关闭">×</button>',
    '</div>',
    '<div class="project-dialog-browser-input-row">',
    '<label class="dialog-field project-dialog-browser-input-field">',
    '<span class="sr-only">项目路径</span>',
    '<input id="project-dialog-input" class="dialog-input project-dialog-browser-input" type="text" name="cwd" placeholder="~/Projects/my-workspace" autocomplete="off" />',
    '</label>',
    '<button class="project-dialog-browser-submit" type="submit" data-project-dialog-submit="true" aria-label="添加项目" title="添加项目">',
    '<span class="project-dialog-browser-submit-icon" aria-hidden="true">',
    '<svg viewBox="0 0 16 16" focusable="false">',
    '<path d="M3.5 8h9" />',
    '<path d="M8.5 3.5 13 8l-4.5 4.5" />',
    '</svg>',
    '</span>',
    '<span class="sr-only">添加项目</span>',
    '</button>',
    '</div>',
    renderProjectDialogTabs(activeTab),
    '<div class="project-dialog-browser-body">',
    activeTab === 'manual'
      ? renderProjectDialogHistoryPanel(state.projects, dialogState.cwdDraft)
      : renderProjectDialogDirectoryPanel(dialogState),
    '</div>',
    '</form>',
  ].join('');
}

export function renderProjectDialogTabs(activeTab) {
  return [
    '<div class="project-dialog-browser-tabs" role="tablist" aria-label="添加项目视图">',
    renderProjectDialogTab('manual', '历史项目', activeTab),
    renderProjectDialogTab('browse', '目录树', activeTab),
    '</div>',
  ].join('');
}

export function renderProjectDialogTab(value, label, activeTab) {
  const selected = value === activeTab;
  return [
    `<button class="history-dialog-tab project-dialog-browser-tab${selected ? ' history-dialog-tab--selected' : ''}" type="button" role="tab" aria-selected="${String(selected)}" data-project-dialog-tab="${value}">`,
    escapeHtml(label),
    '</button>',
  ].join('');
}

export function renderProjectDialogHistoryPanel(projects = [], cwdDraft = '') {
  const historyProjects = collectProjectHistoryProjects(projects);
  if (!historyProjects.length) {
    return [
      '<section class="project-dialog-browser-panel project-dialog-browser-panel--history">',
      '<div class="empty-list">暂时没有可复用的历史项目路径</div>',
      '</section>',
    ].join('');
  }

  const selectedCwd = String(cwdDraft ?? '').trim();
  return [
    '<section class="project-dialog-browser-panel project-dialog-browser-panel--history">',
    '<div class="project-dialog-browser-meta">',
    '<span class="project-dialog-browser-meta-label">历史项目</span>',
    '<span class="project-dialog-browser-meta-value">点击后仅更新输入框草稿</span>',
    '</div>',
    '<div class="project-dialog-browser-history-list">',
    historyProjects
      .map((project) =>
        renderProjectDialogHistoryItem(project, { selected: project.cwd === selectedCwd }),
      )
      .join(''),
    '</div>',
    '</section>',
  ].join('');
}

export function renderProjectDialogHistoryItem(project, { selected = false } = {}) {
  const path = String(project?.cwd ?? '').trim();
  const displayName = String(project?.displayName ?? '').trim();
  const title = displayName || path;
  const subtitle = title && path && title !== path ? path : '';
  const buttonClass = [
    'session-item',
    'session-item--history',
    'project-dialog-browser-history-item',
    selected ? 'session-item--focused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    `<button class="${buttonClass}" type="button" data-project-dialog-history-path="${escapeHtml(path)}"${selected ? ' aria-current="true"' : ''}>`,
    '<span class="session-item-inner">',
    '<span class="session-item-title-row">',
    `<span class="session-title">${escapeHtml(title || '未命名项目')}</span>`,
    '</span>',
    subtitle
      ? `<span class="session-item-subtitle project-dialog-browser-history-path">${escapeHtml(subtitle)}</span>`
      : '',
    '</span>',
    '</button>',
  ].join('');
}

export function renderProjectDialogDirectoryPanel(dialogState) {
  const browser = dialogState.directoryBrowser ?? {};
  const currentPath = browser.currentPath ?? dialogState.cwdDraft ?? '';
  const parentPath = browser.parentPath ?? '';

  return [
    '<section class="project-dialog-browser-panel project-dialog-browser-panel--directory">',
    '<div class="project-dialog-browser-toolbar">',
    '<div class="project-dialog-browser-meta">',
    '<span class="project-dialog-browser-meta-label">当前目录</span>',
    `<span class="project-dialog-browser-meta-value">${escapeHtml(currentPath || '未选择')}</span>`,
    '</div>',
    `<button class="project-dialog-browser-parent${parentPath ? '' : ' project-dialog-browser-parent--disabled'}" type="button" ${parentPath ? `data-project-dialog-parent-path="${escapeHtml(parentPath)}"` : 'disabled'}>返回上一级</button>`,
    '</div>',
    renderProjectDialogDirectoryEntries(browser),
    '</section>',
  ].join('');
}

export function renderProjectDialogDirectoryEntries(browser) {
  if (browser.loading) {
    return '<div class="project-dialog-browser-state">正在加载目录…</div>';
  }

  if (browser.error) {
    return `<div class="project-dialog-browser-state project-dialog-browser-state--error">${escapeHtml(browser.error)}</div>`;
  }

  const entries = Array.isArray(browser.entries) ? browser.entries : [];
  if (!entries.length) {
    return '<div class="empty-list">当前目录暂无可用条目</div>';
  }

  return [
    '<div class="project-dialog-browser-entry-list">',
    entries.map((entry) => renderProjectDialogDirectoryEntry(entry)).join(''),
    '</div>',
  ].join('');
}

export function renderProjectDialogDirectoryEntry(entry) {
  const kind = entry?.kind === 'directory' ? 'directory' : 'file';
  const kindLabel = kind === 'directory' ? '目录' : '文件';
  const titleMarkup = [
    '<span class="project-dialog-browser-entry-copy">',
    `<span class="project-dialog-browser-entry-name">${escapeHtml(entry?.name ?? '未命名条目')}</span>`,
    `<span class="project-dialog-browser-entry-path">${escapeHtml(entry?.path ?? '')}</span>`,
    '</span>',
  ].join('');

  if (kind === 'directory') {
    return [
      `<button class="project-dialog-browser-entry project-dialog-browser-entry--directory" type="button" data-project-dialog-entry-path="${escapeHtml(entry?.path ?? '')}" data-project-dialog-entry-kind="directory">`,
      `<span class="project-dialog-browser-entry-kind">${kindLabel}</span>`,
      titleMarkup,
      '</button>',
    ].join('');
  }

  return [
    '<div class="project-dialog-browser-entry project-dialog-browser-entry--file" aria-disabled="true">',
    `<span class="project-dialog-browser-entry-kind">${kindLabel}</span>`,
    titleMarkup,
    '</div>',
  ].join('');
}

export function collectProjectHistoryPaths(projects = []) {
  return collectProjectHistoryProjects(projects).map((project) => project.cwd);
}

export function collectProjectHistoryProjects(projects = []) {
  const seen = new Set();
  const historyProjects = [];
  for (const project of projects) {
    const path = String(project?.cwd ?? '').trim();
    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);
    historyProjects.push({
      cwd: path,
      displayName: String(project?.displayName ?? '').trim() || path,
    });
  }

  return historyProjects;
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
