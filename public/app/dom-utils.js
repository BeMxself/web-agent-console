import {
  CONVERSATION_AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_PREFERENCE_STORAGE_KEY,
} from './constants.js';
import { parseLocalFileReference } from './file-preview-utils.js';

export function clampPanelWidth(width, fallbackWidth) {
  const numericWidth = Number(width);
  if (!Number.isFinite(numericWidth)) {
    return fallbackWidth;
  }

  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(numericWidth)));
}

export function normalizeCollabToolCallStatus(status) {
  if (status === 'inProgress') {
    return 'running';
  }

  if (status === 'failed') {
    return 'errored';
  }

  return status ?? 'pendingInit';
}

export function formatCollabAgentStatus(status) {
  switch (status) {
    case 'pendingInit':
      return '准备中';
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'interrupted':
      return '已中断';
    case 'errored':
      return '出错';
    case 'shutdown':
      return '已关闭';
    case 'notFound':
      return '未找到';
    default:
      return status ?? '未知';
  }
}

export function getCollabAgentTone(status) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'errored':
    case 'notFound':
      return 'errored';
    case 'interrupted':
    case 'shutdown':
      return 'muted';
    default:
      return 'running';
  }
}

export function setupPanelResizer(handle, { side, controller, getState, documentRef }) {
  if (!handle?.addEventListener) {
    return;
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) {
      return;
    }

    event.preventDefault?.();
    const view = documentRef?.defaultView ?? globalThis;
    const startX = Number(event.clientX ?? 0);
    const startWidth =
      side === 'project' ? getState().projectPanelWidth : getState().activityPanelWidth;

    const onPointerMove = (moveEvent) => {
      const delta = Number(moveEvent.clientX ?? 0) - startX;
      const nextWidth = side === 'project' ? startWidth + delta : startWidth - delta;
      if (side === 'project') {
        controller.setProjectPanelWidth(nextWidth);
        return;
      }

      controller.setActivityPanelWidth(nextWidth);
    };

    const stopResizing = () => {
      view.removeEventListener?.('pointermove', onPointerMove);
      view.removeEventListener?.('pointerup', stopResizing);
      view.removeEventListener?.('pointercancel', stopResizing);
    };

    view.addEventListener?.('pointermove', onPointerMove);
    view.addEventListener?.('pointerup', stopResizing);
    view.addEventListener?.('pointercancel', stopResizing);
  });
}

export function findConversationTurnTarget(turnOffsets, currentScrollTop, direction) {
  if (!Array.isArray(turnOffsets) || !turnOffsets.length) {
    return null;
  }

  const sortedOffsets = [...turnOffsets]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (!sortedOffsets.length) {
    return null;
  }

  if (direction === 'previous') {
    for (let index = sortedOffsets.length - 1; index >= 0; index -= 1) {
      if (sortedOffsets[index] <= currentScrollTop) {
        return sortedOffsets[index];
      }
    }

    return sortedOffsets[0];
  }

  for (const offset of sortedOffsets) {
    if (offset > currentScrollTop) {
      return offset;
    }
  }

  return sortedOffsets.at(-1) ?? null;
}

export function normalizeHistoryDialogTab(tab) {
  return tab === 'archived' ? 'archived' : 'active';
}

export function normalizeMobileDrawerMode(mode) {
  return mode === 'activity' ? 'activity' : 'sessions';
}

export function isMobileViewport(documentRef) {
  const view = documentRef?.defaultView ?? globalThis;
  if (typeof view?.matchMedia === 'function') {
    return Boolean(view.matchMedia('(max-width: 760px)').matches);
  }

  return Number(view?.innerWidth ?? 0) > 0 && Number(view.innerWidth) <= 760;
}

export function jumpConversationByTurn(documentRef, direction) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  const turnOffsets = getConversationTurnOffsets(documentRef);
  const target = findConversationTurnTarget(turnOffsets, conversationScroll.scrollTop, direction);
  if (target == null) {
    return null;
  }

  setConversationScrollTop(conversationScroll, target);
  return target;
}

export function jumpConversationToTurnIndex(documentRef, turnIndex) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  const turnCards = documentRef
    ?.querySelector?.('#conversation-body')
    ?.querySelectorAll?.('[data-turn-card]');
  const turnCard = [...(turnCards ?? [])][turnIndex];
  if (!turnCard) {
    return null;
  }

  const target = Number(turnCard.offsetTop ?? 0);
  setConversationScrollTop(conversationScroll, target);
  return target;
}

export function scrollConversationToBottom(documentRef) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  const target = Number(conversationScroll.scrollHeight ?? conversationScroll.scrollTop ?? 0);
  setConversationScrollTop(conversationScroll, target);
  return target;
}

export function scrollConversationToTop(documentRef) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return null;
  }

  setConversationScrollTop(conversationScroll, 0);
  return 0;
}

export function getConversationTurnOffsets(documentRef) {
  const turnCards = documentRef
    ?.querySelector?.('#conversation-body')
    ?.querySelectorAll?.('[data-turn-card]');
  return [...(turnCards ?? [])].map((card) => Number(card.offsetTop ?? 0));
}

export function setConversationScrollTop(element, top, { smooth = true } = {}) {
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  element.scrollTop = top;
}

export function isConversationNearBottom(documentRef, thresholdPx = CONVERSATION_AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
  const conversationScroll = documentRef?.querySelector?.('#conversation-scroll');
  if (!conversationScroll) {
    return true;
  }

  if (Number(conversationScroll.clientHeight ?? 0) <= 0) {
    return true;
  }

  const remainingDistance =
    Number(conversationScroll.scrollHeight ?? 0) -
    Number(conversationScroll.clientHeight ?? 0) -
    Number(conversationScroll.scrollTop ?? 0);
  return remainingDistance <= thresholdPx;
}

export function requestAnimationFrameSafe(view, callback) {
  if (typeof view?.requestAnimationFrame === 'function') {
    return view.requestAnimationFrame(callback);
  }

  return setTimeout(callback, 0);
}

export function createMarkupCache() {
  return {
    keyParts: null,
    html: '',
  };
}

export function getCachedMarkup(cache, keyParts, renderMarkup) {
  if (sameMarkupCacheKey(cache.keyParts, keyParts)) {
    return {
      html: cache.html,
      changed: false,
    };
  }

  cache.keyParts = keyParts;
  cache.html = renderMarkup();
  return {
    html: cache.html,
    changed: true,
  };
}

export function sameMarkupCacheKey(previousKeyParts, nextKeyParts) {
  if (!Array.isArray(previousKeyParts) || previousKeyParts.length !== nextKeyParts.length) {
    return false;
  }

  return nextKeyParts.every((value, index) => previousKeyParts[index] === value);
}

export function openDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
    return;
  }

  dialog.open = true;
}

export function closeDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close();
    return;
  }

  dialog.open = false;
}

export function restorePersistentState(baseState, storageImpl) {
  const storedPreference = readStoredPanelPreference(storageImpl);
  if (!storedPreference) {
    return { ...baseState };
  }

  return {
    ...baseState,
    persistPanelPreference: true,
    projectPanelCollapsed: storedPreference.projectPanelCollapsed,
    activityPanelCollapsed: storedPreference.activityPanelCollapsed,
    theme: normalizeTheme(storedPreference.theme),
  };
}

export function syncStoredPanelPreference(storageImpl, state) {
  if (!storageImpl?.setItem || !storageImpl?.removeItem) {
    return;
  }

  try {
    storageImpl.setItem(
      PANEL_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        projectPanelCollapsed: state.projectPanelCollapsed,
        activityPanelCollapsed: state.activityPanelCollapsed,
        theme: normalizeTheme(state.theme),
      }),
    );
  } catch {}
}

export function readStoredPanelPreference(storageImpl) {
  if (!storageImpl?.getItem) {
    return null;
  }

  try {
    const raw = storageImpl.getItem(PANEL_PREFERENCE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return {
      persistPanelPreference: true,
      projectPanelCollapsed: Boolean(parsed?.projectPanelCollapsed),
      activityPanelCollapsed: Boolean(parsed?.activityPanelCollapsed),
      theme: normalizeTheme(parsed?.theme),
    };
  } catch {
    return null;
  }
}

export function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

export function focusProjectInput(documentRef) {
  documentRef?.querySelector?.('#project-dialog-input')?.focus?.();
}

export function clearProjectInput(documentRef) {
  const input = documentRef?.querySelector?.('#project-dialog-input');
  if (input) {
    input.value = '';
  }
}

export function clearLoginPassword(documentRef) {
  const input = documentRef?.querySelector?.('#login-password');
  if (input) {
    input.value = '';
  }
}

export function setRenameDialogSession(documentRef, session) {
  const title = documentRef?.querySelector?.('#rename-dialog-session-title');
  if (title) {
    title.textContent = getThreadTitle(session) ?? session?.id ?? '当前会话';
  }

  const input = documentRef?.querySelector?.('#rename-dialog-input');
  if (input) {
    input.value = session?.name ?? getThreadTitle(session) ?? '';
  }
}

export function focusRenameInput(documentRef) {
  const input = documentRef?.querySelector?.('#rename-dialog-input');
  input?.focus?.();
  input?.select?.();
}

export function clearRenameInput(documentRef) {
  const input = documentRef?.querySelector?.('#rename-dialog-input');
  if (input) {
    input.value = '';
  }
}

export function createInitialAuthState() {
  return {
    required: false,
    authenticated: true,
    checking: false,
    pending: false,
    error: null,
  };
}

export function normalizeAuthState(auth) {
  const initialAuth = createInitialAuthState();
  const required = Boolean(auth?.required);
  return {
    ...initialAuth,
    ...(auth ?? {}),
    required,
    authenticated: auth?.authenticated == null ? !required : Boolean(auth?.authenticated),
    checking: Boolean(auth?.checking),
    pending: Boolean(auth?.pending),
    error: auth?.error ?? null,
  };
}

export function applyAuthState(state, auth) {
  const nextAuth = normalizeAuthState(auth);
  const nextState = {
    ...state,
    auth: nextAuth,
  };

  if (nextAuth.authenticated) {
    return nextState;
  }

  return {
    ...nextState,
    projects: [],
    selectedSessionId: null,
    pendingSessionProjectId: null,
    sessionDetailsById: {},
    realtimeBySession: {},
    diffBySession: {},
    turnStatusBySession: {},
    activeTurnIdBySession: {},
    unreadBySession: {},
    composerDraft: '',
    historyDialogProjectId: null,
    historyDialogTab: 'active',
    mobileDrawerOpen: false,
    mobileDrawerMode: 'sessions',
    loadError: null,
  };
}

export function isAuthenticatedAppState(state) {
  return normalizeAuthState(state?.auth).authenticated;
}

export function createInitialSystemStatus() {
  return {
    overall: 'connected',
    relay: { status: 'online' },
    backend: { status: 'connected' },
    requests: { status: 'idle' },
    lastError: null,
  };
}

export function normalizeSystemStatus(status) {
  return {
    ...createInitialSystemStatus(),
    ...(status ?? {}),
    relay: {
      status: status?.relay?.status ?? 'online',
    },
    backend: {
      status: status?.backend?.status ?? 'connected',
    },
    requests: {
      status: status?.requests?.status ?? 'idle',
    },
    lastError: status?.lastError ?? null,
  };
}

export function sameSystemStatus(left, right) {
  const previous = normalizeSystemStatus(left);
  const next = normalizeSystemStatus(right);
  return (
    previous.overall === next.overall &&
    previous.relay.status === next.relay.status &&
    previous.backend.status === next.backend.status &&
    previous.requests.status === next.requests.status &&
    previous.lastError === next.lastError
  );
}

export function getStatusTone(status) {
  if (status.backend?.status === 'connected') {
    return 'connected';
  }

  if (status.backend?.status === 'reconnecting' || status.overall === 'reconnecting') {
    return 'reconnecting';
  }

  return 'disconnected';
}

export function getStatusLabel(status) {
  const tone = getStatusTone(status);
  if (tone === 'connected') {
    return '后端正常';
  }

  if (tone === 'reconnecting') {
    return '后端重连中';
  }

  return '后端断开';
}

export function getCompactStatusLabel(status) {
  const tone = getStatusTone(status);
  if (tone === 'connected') {
    return '在线';
  }

  if (tone === 'reconnecting') {
    return '重连';
  }

  return '断开';
}

export async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  const body = text ? tryParseJson(text) : {};

  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

let markdownParser = null;

export function renderMarkdownMessage(text) {
  const parser = getMarkdownParser();
  if (!parser) {
    return {
      className: 'message-text message-text--plain',
      html: escapeHtml(text),
    };
  }

  return {
    className: 'message-text message-markdown',
    html: parser.render(text),
  };
}

export function getMarkdownParser() {
  if (markdownParser) {
    return markdownParser;
  }

  const factory = globalThis.markdownit;
  if (typeof factory !== 'function') {
    return null;
  }

  const parser = factory({
    html: false,
    linkify: true,
    breaks: true,
  });
  const defaultValidateLink = parser.validateLink?.bind(parser) ?? (() => true);
  parser.validateLink = (url) => {
    if (String(url ?? '').trim().startsWith('file://')) {
      return true;
    }

    return defaultValidateLink(url);
  };

  const defaultLinkOpen =
    parser.renderer.rules.link_open ??
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  parser.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = getTokenAttribute(token, 'href');
    const localFileReference = parseLocalFileReference(href);

    if (localFileReference) {
      ensureTokenAttribute(token, 'data-local-file-path', localFileReference.path);
      if (localFileReference.line) {
        ensureTokenAttribute(token, 'data-local-file-line', String(localFileReference.line));
      }
      if (localFileReference.column) {
        ensureTokenAttribute(token, 'data-local-file-column', String(localFileReference.column));
      }
      appendTokenClass(token, 'message-local-file-link');
    } else {
      ensureTokenAttribute(token, 'target', '_blank');
      ensureTokenAttribute(token, 'rel', 'noreferrer noopener');
    }

    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  markdownParser = parser;
  return markdownParser;
}

export function ensureTokenAttribute(token, name, value) {
  const index = token.attrIndex(name);
  if (index >= 0) {
    token.attrs[index][1] = value;
    return;
  }

  token.attrPush([name, value]);
}

export function getTokenAttribute(token, name) {
  const index = token.attrIndex(name);
  return index >= 0 ? token.attrs[index][1] : null;
}

export function appendTokenClass(token, className) {
  const currentClassName = getTokenAttribute(token, 'class');
  if (!currentClassName) {
    ensureTokenAttribute(token, 'class', className);
    return;
  }

  const classNames = new Set(currentClassName.split(/\s+/).filter(Boolean));
  classNames.add(className);
  ensureTokenAttribute(token, 'class', [...classNames].join(' '));
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeSelectorValue(text) {
  return String(text ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function shouldAutoBootstrapDocument(documentRef) {
  const bootstrapFlag =
    documentRef?.body?.dataset?.webAgentBootstrap ??
    documentRef?.documentElement?.dataset?.webAgentBootstrap ??
    null;

  return bootstrapFlag === 'true';
}
