import {
  isAuthenticatedAppState,
  isMobileViewport,
  jumpConversationByTurn,
  jumpConversationToTurnIndex,
  scrollConversationToBottom,
  scrollConversationToTop,
} from './dom-utils.js';
import { findProject } from './project-utils.js';
import {
  canEditSessionSettings,
  getSelectedSessionSettings,
  normalizeApprovalMode,
  normalizeSessionSettings,
} from './session-utils.js';

export function createRuntimeControllerApi(ctx) {
  return {
    async createProject(cwd) {
      const normalizedCwd = cwd?.trim();
      if (!normalizedCwd) {
        return null;
      }

      const result = await ctx.requestProtectedJson('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: normalizedCwd }),
      });
      if (!result) {
        return null;
      }

      await ctx.controller.loadSessions();
      return normalizedCwd;
    },
    async closeProject(projectId) {
      if (!projectId) {
        return null;
      }

      const project = findProject(ctx.state.projects ?? [], projectId);
      const projectLabel = project?.displayName ?? project?.cwd ?? projectId;
      const view = ctx.documentRef?.defaultView ?? globalThis;
      if (
        typeof view?.confirm === 'function' &&
        !view.confirm(`确认删除项目“${projectLabel}”？`)
      ) {
        return null;
      }

      const result = await ctx.requestProtectedJson(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      });
      if (!result) {
        return null;
      }

      await ctx.controller.loadSessions();
      return projectId;
    },
    async renameSession(sessionId = ctx.pendingRenameSessionId ?? ctx.state.selectedSessionId, name) {
      const normalizedName = String(name ?? '').trim();
      if (!sessionId || !normalizedName) {
        return null;
      }

      const result = await ctx.requestProtectedJson(`/api/sessions/${sessionId}/name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: normalizedName }),
      });
      if (!result) {
        return null;
      }

      ctx.applyAction({
        type: 'thread_name_updated',
        payload: {
          threadId: sessionId,
          name: result?.thread?.name ?? normalizedName,
        },
      });
      await ctx.controller.loadSessions();
      if (ctx.state.selectedSessionId === sessionId) {
        await ctx.loadSessionDetail(sessionId).catch(() => null);
      }
      ctx.controller.closeRenameDialog();
      return {
        ...result,
        thread: {
          ...(result?.thread ?? {}),
          id: sessionId,
          name: result?.thread?.name ?? normalizedName,
        },
      };
    },
    async startSessionInProject(projectId) {
      if (!projectId) {
        return null;
      }

      if (isMobileViewport(ctx.documentRef) && ctx.state.mobileDrawerOpen) {
        ctx.applyAction({ type: 'mobile_drawer_closed' });
      }

      ctx.applyAction({
        type: 'project_session_drafted',
        payload: { projectId },
      });
      scrollConversationToTop(ctx.documentRef);
      return { pendingProjectId: projectId };
    },
    async removeFocusedSession(projectId, threadId) {
      const result = await ctx.requestProtectedJson(
        `/api/projects/${encodeURIComponent(projectId)}/focused-sessions/${encodeURIComponent(threadId)}`,
        {
          method: 'DELETE',
        },
      );
      if (!result) {
        return null;
      }

      await ctx.controller.loadSessions();
      return threadId;
    },
    async setApprovalMode(mode) {
      const nextMode = normalizeApprovalMode(mode);
      if (ctx.approvalModeRequestInFlight || !nextMode || nextMode === ctx.state.approvalMode) {
        return null;
      }

      ctx.approvalModeRequestInFlight = true;
      ctx.approvalUiError = null;
      ctx.render();

      try {
        const result = await ctx.requestProtectedJson('/api/approval-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: nextMode }),
        });
        if (!result) {
          return null;
        }

        ctx.applyAction({ type: 'approval_mode_changed', payload: result });
        return result;
      } catch (error) {
        ctx.approvalUiError = error?.message ?? '审批模式更新失败';
        return null;
      } finally {
        ctx.approvalModeRequestInFlight = false;
        ctx.render();
      }
    },
    async setSessionSettings(sessionId = ctx.state.selectedSessionId, settings) {
      const targetSessionId = String(sessionId ?? '').trim();
      if (
        !targetSessionId ||
        ctx.sessionSettingsRequestInFlight ||
        !canEditSessionSettings(ctx.state, targetSessionId)
      ) {
        return null;
      }

      const nextSettings = normalizeSessionSettings(settings);
      const previousSettings = normalizeSessionSettings(ctx.state.sessionSettingsById[targetSessionId]);
      if (
        previousSettings.model === nextSettings.model &&
        previousSettings.reasoningEffort === nextSettings.reasoningEffort &&
        previousSettings.agentType === nextSettings.agentType &&
        previousSettings.sandboxMode === nextSettings.sandboxMode
      ) {
        return previousSettings;
      }

      ctx.sessionSettingsRequestInFlight = true;
      ctx.sessionSettingsPendingThreadId = targetSessionId;
      ctx.sessionSettingsUiError = null;
      ctx.render();

      try {
        const requestBody = {
          model: nextSettings.model,
          reasoningEffort: nextSettings.reasoningEffort,
          ...(nextSettings.agentType ? { agentType: nextSettings.agentType } : {}),
          ...(nextSettings.sandboxMode ? { sandboxMode: nextSettings.sandboxMode } : {}),
        };
        const result = await ctx.requestProtectedJson(`/api/sessions/${targetSessionId}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        if (!result) {
          return null;
        }

        ctx.applyAction({
          type: 'session_settings_changed',
          payload: { threadId: targetSessionId, settings: result },
        });
        return normalizeSessionSettings(result);
      } catch (error) {
        ctx.sessionSettingsUiError = error?.message ?? '会话设置更新失败';
        return null;
      } finally {
        ctx.sessionSettingsRequestInFlight = false;
        ctx.sessionSettingsPendingThreadId = null;
        ctx.render();
      }
    },
    async approveRequest(approvalId) {
      return ctx.controller.resolveApprovalRequest(approvalId, 'approve');
    },
    async denyRequest(approvalId) {
      return ctx.controller.resolveApprovalRequest(approvalId, 'deny');
    },
    async resolveApprovalRequest(approvalId, resolution) {
      const normalizedApprovalId = String(approvalId ?? '').trim();
      if (
        !normalizedApprovalId ||
        ctx.approvalRequestIdsInFlight.has(normalizedApprovalId) ||
        (resolution !== 'approve' && resolution !== 'deny')
      ) {
        return null;
      }

      ctx.approvalRequestIdsInFlight.add(normalizedApprovalId);
      ctx.approvalUiError = null;
      ctx.render();

      try {
        const result = await ctx.requestProtectedJson(
          `/api/approvals/${encodeURIComponent(normalizedApprovalId)}/${resolution}`,
          {
            method: 'POST',
          },
        );
        if (!result) {
          return null;
        }

        await ctx.controller.loadSessions();
        if (ctx.state.selectedSessionId) {
          await ctx.loadSessionDetail(ctx.state.selectedSessionId).catch(() => null);
        }
        return result;
      } catch (error) {
        ctx.approvalUiError = error?.message ?? '审批处理失败';
        return null;
      } finally {
        ctx.approvalRequestIdsInFlight.delete(normalizedApprovalId);
        ctx.render();
      }
    },
    async resolvePendingAction(actionId, resolution = {}) {
      const normalizedActionId = String(actionId ?? '').trim();
      if (!normalizedActionId || ctx.pendingActionRequestIdsInFlight.has(normalizedActionId)) {
        return null;
      }

      ctx.pendingActionRequestIdsInFlight.add(normalizedActionId);
      ctx.pendingActionUiError = null;
      ctx.render();

      try {
        const result = await ctx.requestProtectedJson(
          `/api/pending-actions/${encodeURIComponent(normalizedActionId)}/respond`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(resolution ?? {}),
          },
        );
        if (!result) {
          return null;
        }

        await ctx.controller.loadSessions();
        if (ctx.state.selectedSessionId) {
          await ctx.loadSessionDetail(ctx.state.selectedSessionId).catch(() => null);
        }
        return result;
      } catch (error) {
        ctx.pendingActionUiError = error?.message ?? '问题回复失败';
        return null;
      } finally {
        ctx.pendingActionRequestIdsInFlight.delete(normalizedActionId);
        ctx.render();
      }
    },
    jumpConversationToBottom() {
      ctx.ensureConversationWindowBoundary('bottom');
      ctx.render();
      return scrollConversationToBottom(ctx.documentRef);
    },
    jumpConversationToTop() {
      ctx.ensureConversationWindowBoundary('top');
      ctx.render();
      return scrollConversationToTop(ctx.documentRef);
    },
    jumpConversationByTurn(direction) {
      const target = jumpConversationByTurn(ctx.documentRef, direction);
      if (target != null) {
        return target;
      }

      const expanded = direction === 'previous' ? ctx.expandConversationWindow('up') : ctx.expandConversationWindow('down');
      if (!expanded) {
        return null;
      }

      return jumpConversationByTurn(ctx.documentRef, direction);
    },
    jumpConversationToTurnIndex(turnIndex) {
      ctx.ensureConversationWindowContainsTurn(turnIndex);
      ctx.render();
      return jumpConversationToTurnIndex(ctx.documentRef, turnIndex);
    },
    connectEvents() {
      if (!isAuthenticatedAppState(ctx.state)) {
        return null;
      }

      if (ctx.eventSource) {
        return ctx.eventSource;
      }

      ctx.eventSource = ctx.eventSourceFactory('/api/events');
      ctx.eventSource.onmessage = (event) => {
        const action = JSON.parse(event.data);
        ctx.applyAction(action);
        if (
          action?.type === 'approval_requested' ||
          action?.type === 'approval_resolved' ||
          action?.type === 'pending_question_requested' ||
          action?.type === 'pending_question_resolved'
        ) {
          void ctx.controller.loadSessions();
        }
        void ctx.refreshSessionAfterEvent(action);
      };
      return ctx.eventSource;
    },
    destroy() {
      ctx.stopStatusPolling();
      ctx.disconnectEvents();
    },
  };
}
