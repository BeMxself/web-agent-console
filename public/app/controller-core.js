import { CONVERSATION_WINDOW_EDGE_TRIGGER_PX } from './constants.js';
import { createRuntimeControllerApi } from './controller-runtime-api.js';
import { createSessionControllerApi } from './controller-session-api.js';
import { bindControllerDocumentEvents, renderApp } from './controller-dom.js';
import {
  clearLoginPassword,
  createMarkupCache,
  requestAnimationFrameSafe,
  requestJson,
  restorePersistentState,
  setConversationScrollTop,
  syncStoredPanelPreference,
} from './dom-utils.js';
import { findThreadMeta } from './project-utils.js';
import {
  createEarliestConversationWindow,
  createLatestConversationWindow,
  ensureConversationTurnWindowContainsTurn,
  expandConversationTurnWindow,
  resolveConversationTurnWindow,
  sameConversationWindow,
} from './render-shell.js';
import { maybeAutoScrollConversation, shouldRefreshSessionAfterEvent } from './session-utils.js';
import { initialState, reduceState } from './state.js';

export function createAppController({
  fetchImpl = globalThis.fetch.bind(globalThis),
  eventSourceFactory = (url) => new EventSource(url),
  documentRef = globalThis.document ?? null,
  storageImpl = globalThis.localStorage ?? null,
} = {}) {
  const ctx = {
    fetchImpl,
    eventSourceFactory,
    documentRef,
    storageImpl,
    state: restorePersistentState(initialState, storageImpl),
    eventSource: null,
    statusTimer: null,
    pendingRenameSessionId: null,
    approvalModeRequestInFlight: false,
    approvalRequestIdsInFlight: new Set(),
    approvalUiError: null,
    pendingActionRequestIdsInFlight: new Set(),
    pendingActionUiError: null,
    sessionSettingsRequestInFlight: false,
    sessionSettingsPendingThreadId: null,
    sessionSettingsUiError: null,
    boundConversationScroll: null,
    conversationScrollFramePending: false,
    suppressConversationScrollHandling: false,
    conversationWindowBySession: new Map(),
    renderCache: {
      sessionList: createMarkupCache(),
      conversationBody: createMarkupCache(),
      activityPanel: createMarkupCache(),
      approvalModeControls: createMarkupCache(),
    },
  };

  function stopStatusPolling() {
    if (ctx.statusTimer) {
      clearInterval(ctx.statusTimer);
      ctx.statusTimer = null;
    }
  }

  function disconnectEvents() {
    ctx.eventSource?.close?.();
    ctx.eventSource = null;
  }

  function invalidateConversationMarkupCache() {
    ctx.renderCache.conversationBody.keyParts = null;
  }

  function getConversationWindow(
    sessionId = ctx.state.selectedSessionId,
    detail = ctx.state.sessionDetailsById?.[sessionId],
  ) {
    if (!sessionId || !detail) {
      return null;
    }

    const totalTurns = detail.turns?.length ?? 0;
    const nextWindow = resolveConversationTurnWindow(
      ctx.conversationWindowBySession.get(sessionId),
      totalTurns,
    );
    if (!nextWindow.windowed) {
      ctx.conversationWindowBySession.delete(sessionId);
      return null;
    }

    const currentWindow = ctx.conversationWindowBySession.get(sessionId);
    if (!sameConversationWindow(currentWindow, nextWindow)) {
      ctx.conversationWindowBySession.set(sessionId, nextWindow);
    }

    return nextWindow;
  }

  function setConversationWindow(sessionId, detail, nextWindow) {
    if (!sessionId || !detail) {
      return null;
    }

    const normalizedWindow = resolveConversationTurnWindow(
      nextWindow,
      detail.turns?.length ?? 0,
    );
    if (!normalizedWindow.windowed) {
      ctx.conversationWindowBySession.delete(sessionId);
      invalidateConversationMarkupCache();
      return null;
    }

    ctx.conversationWindowBySession.set(sessionId, normalizedWindow);
    invalidateConversationMarkupCache();
    return normalizedWindow;
  }

  function syncConversationWindowForDetail(sessionId, detail, { anchorLatest = false } = {}) {
    if (!sessionId || !detail) {
      return null;
    }

    if (anchorLatest) {
      return setConversationWindow(
        sessionId,
        detail,
        createLatestConversationWindow(detail.turns?.length ?? 0),
      );
    }

    const totalTurns = detail.turns?.length ?? 0;
    const currentWindow = ctx.conversationWindowBySession.get(sessionId);
    const nextWindow = resolveConversationTurnWindow(currentWindow, totalTurns);
    if (!nextWindow.windowed) {
      ctx.conversationWindowBySession.delete(sessionId);
      invalidateConversationMarkupCache();
      return null;
    }

    ctx.conversationWindowBySession.set(sessionId, nextWindow);
    invalidateConversationMarkupCache();
    return nextWindow;
  }

  function bindConversationScroll(element) {
    if (!element || ctx.boundConversationScroll === element) {
      return;
    }

    if (ctx.boundConversationScroll?.removeEventListener) {
      ctx.boundConversationScroll.removeEventListener('scroll', handleConversationScroll);
    }

    ctx.boundConversationScroll = element;
    ctx.boundConversationScroll.addEventListener('scroll', handleConversationScroll);
  }

  function handleConversationScroll() {
    if (ctx.suppressConversationScrollHandling || ctx.conversationScrollFramePending) {
      return;
    }

    ctx.conversationScrollFramePending = true;
    requestAnimationFrameSafe(ctx.documentRef?.defaultView ?? globalThis, () => {
      ctx.conversationScrollFramePending = false;
      maybeExpandConversationWindowFromScroll();
    });
  }

  function maybeExpandConversationWindowFromScroll() {
    if (ctx.suppressConversationScrollHandling) {
      return false;
    }

    const conversationScroll = ctx.documentRef?.querySelector?.('#conversation-scroll');
    const detail = ctx.state.sessionDetailsById?.[ctx.state.selectedSessionId];
    const currentWindow = getConversationWindow(ctx.state.selectedSessionId, detail);
    if (!conversationScroll || !detail || !currentWindow) {
      return false;
    }

    if (
      Number(conversationScroll.scrollTop ?? 0) <= CONVERSATION_WINDOW_EDGE_TRIGGER_PX &&
      currentWindow.hiddenBeforeCount > 0
    ) {
      return expandConversationWindow('up');
    }

    const distanceToBottom =
      Number(conversationScroll.scrollHeight ?? 0) -
      Number(conversationScroll.clientHeight ?? 0) -
      Number(conversationScroll.scrollTop ?? 0);
    if (
      distanceToBottom <= CONVERSATION_WINDOW_EDGE_TRIGGER_PX &&
      currentWindow.hiddenAfterCount > 0
    ) {
      return expandConversationWindow('down');
    }

    return false;
  }

  function expandConversationWindow(direction) {
    const sessionId = ctx.state.selectedSessionId;
    const detail = ctx.state.sessionDetailsById?.[sessionId];
    const conversationScroll = ctx.documentRef?.querySelector?.('#conversation-scroll');
    const currentWindow = getConversationWindow(sessionId, detail);
    if (!sessionId || !detail || !conversationScroll || !currentWindow) {
      return false;
    }

    const nextWindow = expandConversationTurnWindow(
      currentWindow,
      detail.turns?.length ?? 0,
      direction,
    );
    if (!nextWindow || sameConversationWindow(currentWindow, nextWindow)) {
      return false;
    }

    const previousScrollTop = Number(conversationScroll.scrollTop ?? 0);
    const previousScrollHeight = Number(conversationScroll.scrollHeight ?? 0);
    setConversationWindow(sessionId, detail, nextWindow);
    ctx.render();

    if (direction === 'up') {
      const nextScrollHeight = Number(conversationScroll.scrollHeight ?? previousScrollHeight);
      const scrollDelta = Math.max(0, nextScrollHeight - previousScrollHeight);
      ctx.suppressConversationScrollHandling = true;
      setConversationScrollTop(conversationScroll, previousScrollTop + scrollDelta, {
        smooth: false,
      });
      requestAnimationFrameSafe(ctx.documentRef?.defaultView ?? globalThis, () => {
        ctx.suppressConversationScrollHandling = false;
      });
    }

    return true;
  }

  function ensureConversationWindowBoundary(boundary) {
    const sessionId = ctx.state.selectedSessionId;
    const detail = ctx.state.sessionDetailsById?.[sessionId];
    if (!sessionId || !detail) {
      return null;
    }

    const nextWindow =
      boundary === 'top'
        ? createEarliestConversationWindow(detail.turns?.length ?? 0)
        : createLatestConversationWindow(detail.turns?.length ?? 0);
    const currentWindow = getConversationWindow(sessionId, detail);
    if (sameConversationWindow(currentWindow, nextWindow)) {
      return currentWindow;
    }

    return setConversationWindow(sessionId, detail, nextWindow);
  }

  function ensureConversationWindowContainsTurn(turnIndex) {
    const sessionId = ctx.state.selectedSessionId;
    const detail = ctx.state.sessionDetailsById?.[sessionId];
    if (!sessionId || !detail) {
      return null;
    }

    const currentWindow = getConversationWindow(sessionId, detail);
    const nextWindow = ensureConversationTurnWindowContainsTurn(
      currentWindow,
      detail.turns?.length ?? 0,
      turnIndex,
    );
    if (sameConversationWindow(currentWindow, nextWindow)) {
      return currentWindow;
    }

    return setConversationWindow(sessionId, detail, nextWindow);
  }

  function setAuthenticated(required = false) {
    ctx.applyAction({
      type: 'auth_state_changed',
      payload: {
        required: Boolean(required),
        authenticated: true,
        checking: false,
        pending: false,
        error: null,
      },
    });
    ctx.controller.connectEvents();
  }

  function handleUnauthorized(message = null) {
    stopStatusPolling();
    disconnectEvents();
    clearLoginPassword(ctx.documentRef);
    ctx.applyAction({
      type: 'auth_state_changed',
      payload: {
        required: true,
        authenticated: false,
        checking: false,
        pending: false,
        error: message,
      },
    });
    return null;
  }

  async function requestProtectedJson(url, options) {
    try {
      return await requestJson(ctx.fetchImpl, url, options);
    } catch (error) {
      if (error?.status === 401) {
        return handleUnauthorized();
      }

      throw error;
    }
  }

  function applyAction(action) {
    const previousState = ctx.state;
    ctx.state = reduceState(ctx.state, action);
    ctx.render();
    maybeAutoScrollConversation(
      ctx.documentRef,
      previousState,
      ctx.state,
      action,
      getConversationWindow(
        ctx.state.selectedSessionId,
        ctx.state.sessionDetailsById?.[ctx.state.selectedSessionId],
      ),
    );
    syncStoredPanelPreference(ctx.storageImpl, ctx.state);
    return ctx.state;
  }

  async function loadSessionDetail(sessionId, options = {}) {
    const detail = await requestProtectedJson(`/api/sessions/${sessionId}`);
    if (!detail) {
      return null;
    }

    syncConversationWindowForDetail(sessionId, detail.thread, options);
    applyAction({ type: 'session_detail_loaded', payload: detail });
    return detail;
  }

  async function refreshSessionAfterEvent(action) {
    const threadId =
      action?.payload?.threadId ??
      action?.threadId ??
      action?.payload?.approval?.threadId ??
      null;
    if (!threadId || !shouldRefreshSessionAfterEvent(action)) {
      return null;
    }

    if (!findThreadMeta(ctx.state.projects, threadId)) {
      return null;
    }

    try {
      return await loadSessionDetail(threadId);
    } catch {
      return null;
    }
  }

  ctx.stopStatusPolling = stopStatusPolling;
  ctx.disconnectEvents = disconnectEvents;
  ctx.getConversationWindow = getConversationWindow;
  ctx.setConversationWindow = setConversationWindow;
  ctx.syncConversationWindowForDetail = syncConversationWindowForDetail;
  ctx.bindConversationScroll = bindConversationScroll;
  ctx.expandConversationWindow = expandConversationWindow;
  ctx.ensureConversationWindowBoundary = ensureConversationWindowBoundary;
  ctx.ensureConversationWindowContainsTurn = ensureConversationWindowContainsTurn;
  ctx.setAuthenticated = setAuthenticated;
  ctx.handleUnauthorized = handleUnauthorized;
  ctx.requestProtectedJson = requestProtectedJson;
  ctx.applyAction = applyAction;
  ctx.loadSessionDetail = loadSessionDetail;
  ctx.refreshSessionAfterEvent = refreshSessionAfterEvent;
  ctx.render = () => renderApp(ctx);

  ctx.controller = {
    lastPostedTurn: null,
    ...createSessionControllerApi(ctx),
    ...createRuntimeControllerApi(ctx),
  };

  bindControllerDocumentEvents(ctx);
  ctx.render();
  return ctx.controller;
}
