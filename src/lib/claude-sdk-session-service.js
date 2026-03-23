import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkEventMapper } from './claude-sdk-event-mapper.js';
import {
  buildPermissionDetail,
  ClaudeExternalSessionBridge,
  createExternalApprovalId,
  createExternalQuestionId,
  createExternalTurnId,
  normalizeEventQuestions,
  summarizePermissionRequest,
  summarizeQuestion,
} from './claude-external-session-bridge.js';
import { ClaudeExternalTranscriptWatcher } from './claude-external-transcript-watcher.js';
import {
  buildClaudeThreadFromTranscript,
  createClaudeThreadPlaceholder,
} from './claude-transcript-adapter.js';
import {
  createClaudePromptStream,
  validateClaudeAttachments,
} from './claude-attachments.js';
import {
  cloneSessionSettings,
  createCompletedRuntimeSnapshot,
  createErroredRuntimeSnapshot,
  createInterruptedRuntimeSnapshot,
  createInterruptingRuntimeSnapshot,
  createStartedRuntimeSnapshot,
  hasRuntimeSnapshot,
  isRuntimeSnapshotActive,
  normalizeRuntimeRealtimeState,
  normalizeRuntimeSnapshot,
  nowInSeconds,
  SessionService,
  updateRuntimeSessionId,
} from './session-service.js';
import { normalizeTurnRequestInput } from './turn-request.js';
import {
  createPendingQuestionRecordFromPendingAction,
  normalizePendingActionRecord,
} from './runtime-store.js';


import {
  createThreadStub,
  createImportedClaudeThreadId,
  buildKnownThreadsBySessionId,
  choosePreferredSessionThread,
  isImportedClaudeThread,
  isPrunableDiscoveredThread,
  buildSessionLookupOptions,
  buildQueryOptions,
  getQuerySessionId,
  extractAskUserQuestionToolUse,
  submitAskUserQuestionResponse,
  createSingleMessageStream,
  summarizeClaudeToolApproval,
  closeClaudeQuery,
  buildIgnoredResult,
  createStartedHookRuntime,
  createCompletedHookRuntime,
  createErroredHookRuntime,
  attachExternalSessionSnapshot,
  normalizeExternalSessionSnapshot,
  normalizeBridgeMode,
  getExternalRuntimeSource,
  createDeferred,
  createQuestionResponse,
  normalizeQuestionAnswers,
  normalizeToolApprovalDecision,
  normalizeDeniedMessage,
  isAbortError,
  isActiveExternalHookRuntime,
  normalizeSessionModel,
  normalizeSessionReasoningEffort,
  normalizeClaudeSessionSettings,
  shouldPersistClaudeSessionSettings,
  normalizeString,
  normalizeTimestampMs,
  normalizeTimestampSeconds,
  compareProjects,
} from './claude-sdk-session-service-helpers.js';

import {
  ingestExternalBridgeEvent,
  handleExternalHookEvent,
  handleExternalSessionStart,
  handleExternalPermissionRequest,
  handleExternalPostToolUse,
  handleExternalElicitation,
  handleExternalElicitationResult,
  handleExternalStop,
  handleExternalStopFailure,
  prepareExternalHookThread,
  buildAcceptedExternalThreadResult,
  resolveExternalPendingActions,
  resolveOpenExternalPendingActions,
  finalizeExternalPendingAction,
  ensureExternalBridgeThread,
} from './claude-sdk-session-service-external.js';

import {
  loadProjectThreadMap,
  syncDiscoveredSessionsForProject,
  loadTranscriptThread,
  tryReconcileCompletedTranscript,
  runTurn,
  reconcileDuplicateSessionThreads,
  pruneStaleDiscoveredThreads,
  migrateThreadState,
  findThreadByClaudeSessionId,
  syncExternalTranscriptWatcher,
  stopExternalTranscriptWatcher,
} from './claude-sdk-session-service-projects.js';

const DEFAULT_CLAUDE_SDK = Object.freeze({
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
});

const DEFAULT_SESSION_OPTIONS = Object.freeze({
  modelOptions: Object.freeze([
    Object.freeze({ value: '', label: '默认' }),
    Object.freeze({ value: 'sonnet', label: 'sonnet' }),
    Object.freeze({ value: 'opus', label: 'opus' }),
    Object.freeze({ value: 'haiku', label: 'haiku' }),
  ]),
  reasoningEffortOptions: Object.freeze([
    Object.freeze({ value: '', label: '默认' }),
    Object.freeze({ value: 'low', label: '低' }),
    Object.freeze({ value: 'medium', label: '中' }),
    Object.freeze({ value: 'high', label: '高' }),
  ]),
  defaults: Object.freeze({
    model: null,
    reasoningEffort: null,
  }),
});

const DEFAULT_CLAUDE_SETTING_SOURCES = Object.freeze([
  'user',
  'project',
  'local',
]);


export class ClaudeSdkSessionService extends SessionService {
  constructor({
    activityStore,
    claudeSdk = DEFAULT_CLAUDE_SDK,
    runtimeStore = null,
    cwd = process.cwd(),
    sessionIndex,
    externalTranscriptPollMs = 100,
  }) {
    super({
      activityStore,
      runtimeStore,
      sessionOptions: DEFAULT_SESSION_OPTIONS,
    });
    this.claudeSdk = claudeSdk;
    this.cwd = cwd;
    this.sessionIndex = sessionIndex;
    this.externalTranscriptPollMs = externalTranscriptPollMs;
    this.activeTurnsByThread = new Map();
    this.externalTranscriptWatchersByThread = new Map();
    this.externalSessionBridge = new ClaudeExternalSessionBridge();
  }

  subscribe(handler) {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  async listProjects() {
    await this.ensureRuntimeStoreLoaded();
    const initialActivity = await this.activityStore.load();
    const visibleProjectIds = Object.entries(initialActivity.projects ?? {})
      .filter(([, project]) => !project?.hidden)
      .map(([projectId]) => projectId);

    for (const projectId of visibleProjectIds) {
      try {
        await this.syncDiscoveredSessionsForProject(projectId);
      } catch {
        // Fall back to already-indexed sessions when SDK discovery is unavailable.
      }
    }

    const activity = await this.activityStore.load();
    const threadIdsByProject = await this.sessionIndex.listThreadIdsByProject();
    const projects = [];

    for (const [projectId, project] of Object.entries(activity.projects ?? {})) {
      if (project?.hidden) {
        continue;
      }

      const focusedThreadIds = [...(project?.focusedThreadIds ?? [])];
      const indexedThreadIds = threadIdsByProject.get(projectId) ?? [];
      const threadsById = await this.loadProjectThreadMap(projectId, new Set([...focusedThreadIds, ...indexedThreadIds]));
      const focusedSessions = focusedThreadIds
        .map((threadId) => threadsById.get(threadId) ?? createThreadStub(threadId, projectId))
        .filter(Boolean);
      const focusedIds = new Set(focusedSessions.map((thread) => thread.id));
      const historySessions = indexedThreadIds
        .map((threadId) => threadsById.get(threadId) ?? createThreadStub(threadId, projectId))
        .filter((thread) => thread && !focusedIds.has(thread.id));
      const updatedAt = Math.max(
        0,
        ...focusedSessions.map((thread) => thread.updatedAt ?? 0),
        ...historySessions.map((thread) => thread.updatedAt ?? 0),
      );

      projects.push({
        id: projectId,
        cwd: projectId,
        displayName: basename(projectId) || projectId,
        collapsed: Boolean(project?.collapsed),
        focusedSessions,
        historySessions: {
          active: historySessions,
          archived: [],
        },
        updatedAt,
      });
    }

    return {
      projects: projects.sort(compareProjects),
    };
  }

  async createSessionInProject(projectId) {
    await this.ensureRuntimeStoreLoaded();
    await this.activityStore.addProject(projectId);
    const timestamp = nowInSeconds();
    const threadRecord = await this.sessionIndex.upsertThread({
      threadId: `claude-thread-${randomUUID()}`,
      projectId,
      claudeSessionId: null,
      summary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.activityStore.addFocusedSession(projectId, threadRecord.threadId);
    return {
      thread: this.decorateThread(createClaudeThreadPlaceholder(threadRecord), threadRecord),
    };
  }

  async readSession(threadId) {
    await this.ensureRuntimeStoreLoaded();
    const threadRecord = await this.sessionIndex.readThread(threadId);
    if (!threadRecord) {
      throw new Error(`Claude thread not found: ${threadId}`);
    }

    if (!threadRecord.claudeSessionId) {
      return {
        thread: this.decorateThread(createClaudeThreadPlaceholder(threadRecord), threadRecord),
      };
    }

    const detail = await this.loadTranscriptThread(threadRecord);

    return {
      thread: this.decorateThread(detail.thread, detail.threadRecord ?? threadRecord),
    };
  }

  async startTurn(threadId, turnRequestOrText, settings = null) {
    await this.ensureRuntimeStoreLoaded();
    const threadRecord = await this.sessionIndex.readThread(threadId);
    if (!threadRecord) {
      throw new Error(`Claude thread not found: ${threadId}`);
    }

    if (isActiveExternalHookRuntime(this.runtimeByThread.get(threadId))) {
      throw new Error(`Claude thread already running externally for thread ${threadId}`);
    }

    if (this.activeTurnsByThread.has(threadId)) {
      throw new Error(`Claude turn already running for thread ${threadId}`);
    }

    const turnId = `turn-${randomUUID()}`;
    const abortController = new AbortController();
    const startDeferred = createDeferred();
    const activeTurn = {
      turnId,
      abortController,
    };

    this.activeTurnsByThread.set(threadId, activeTurn);
    this.setRuntime(threadId, createStartedRuntimeSnapshot({
      runtime: this.runtimeByThread.get(threadId),
      turnId,
      sessionId: threadRecord.claudeSessionId,
    }));
    await this.persistRuntimeSnapshot(threadId);
    this.publishEvent({
      type: 'turn_started',
      threadId,
      payload: {
        threadId,
        turnId,
      },
    });
    this.publishThreadStatusChanged(threadId, {
      type: 'active',
      activeFlags: ['running'],
    });

    void this.runTurn({
      activeTurn,
      abortController,
      settings,
      startDeferred,
      turnRequestOrText,
      threadId,
      threadRecord,
      turnId,
    }).finally(() => {
      if (this.activeTurnsByThread.get(threadId) === activeTurn) {
        this.activeTurnsByThread.delete(threadId);
      }
    });

    await startDeferred.promise;

    const currentThreadRecord = await this.sessionIndex.readThread(threadId) ?? threadRecord;
    return {
      turnId,
      status: 'started',
      thread: this.decorateThread(
        createClaudeThreadPlaceholder(currentThreadRecord),
        currentThreadRecord,
      ),
    };
  }

  async interruptTurn(threadId, turnId) {
    await this.ensureRuntimeStoreLoaded();
    const activeTurn = this.activeTurnsByThread.get(threadId);
    if (!activeTurn || (turnId && activeTurn.turnId !== turnId)) {
      return null;
    }

    this.setRuntime(threadId, createInterruptingRuntimeSnapshot(this.runtimeByThread.get(threadId)));
    await this.persistRuntimeSnapshot(threadId);
    activeTurn.abortController.abort();

    const threadRecord = await this.sessionIndex.readThread(threadId);
    return {
      interrupted: true,
      thread: this.decorateThread(
        createClaudeThreadPlaceholder(threadRecord ?? { threadId, projectId: this.cwd }),
        threadRecord ?? { threadId, projectId: this.cwd },
      ),
    };
  }

  async markActiveSessionsInterrupted(reason = 'claude-sdk backend restarted') {
    await this.ensureRuntimeStoreLoaded();
    const threadIds = [];

    for (const [threadId, runtime] of this.runtimeByThread.entries()) {
      if (!isRuntimeSnapshotActive(runtime)) {
        continue;
      }

      const reconciledThread = await this.tryReconcileCompletedTranscript(threadId);
      if (reconciledThread) {
        const clearedRuntime = normalizeRuntimeSnapshot({});
        this.setRuntime(threadId, clearedRuntime);
        await this.persistRuntimeSnapshot(threadId);
        this.publishThreadStatusChanged(threadId, { type: 'idle' });
        this.publishRuntimeReconciled(threadId, clearedRuntime);
        continue;
      }

      if (runtime?.source === 'claude-hook') {
        continue;
      }

      const nextRuntime = createInterruptedRuntimeSnapshot(runtime, reason);
      this.setRuntime(threadId, nextRuntime);
      await this.persistRuntimeSnapshot(threadId);
      this.publishThreadStatusChanged(threadId, { type: 'idle' });
      this.publishRuntimeReconciled(threadId, nextRuntime);
      threadIds.push(threadId);
    }

    return {
      ok: true,
      threadIds,
    };
  }

  async addFocusedSession(projectId, threadId) {
    await this.activityStore.addFocusedSession(projectId, threadId);
    return { ok: true };
  }

  async removeFocusedSession(projectId, threadId) {
    await this.activityStore.removeFocusedSession(projectId, threadId);
    return { ok: true };
  }

  async setProjectCollapsed(projectId, collapsed) {
    await this.activityStore.setCollapsed(projectId, collapsed);
    return { ok: true };
  }

  async addProject(projectId) {
    await this.activityStore.addProject(projectId);
    return { ok: true };
  }

  async closeProject(projectId) {
    await this.activityStore.hideProject(projectId);
    return { ok: true };
  }

  async renameSession(threadId, name) {
    await this.ensureRuntimeStoreLoaded();
    const normalizedName = normalizeString(name);
    const threadRecord = await this.sessionIndex.readThread(threadId);
    if (!threadRecord) {
      throw new Error(`Claude thread not found: ${threadId}`);
    }

    if (threadRecord.claudeSessionId && typeof this.claudeSdk.renameSession === 'function') {
      await this.claudeSdk.renameSession(
        threadRecord.claudeSessionId,
        normalizedName ?? '',
        buildSessionLookupOptions(threadRecord),
      );
    }

    const renamedThreadRecord = await this.sessionIndex.upsertThread({
      ...threadRecord,
      summary: normalizedName,
      updatedAt: nowInSeconds(),
    });
    const detail = renamedThreadRecord.claudeSessionId
      ? await this.loadTranscriptThread(renamedThreadRecord)
      : {
          thread: createClaudeThreadPlaceholder(renamedThreadRecord),
        };

    return {
      thread: this.decorateThread(detail.thread, detail.threadRecord ?? renamedThreadRecord),
    };
  }

  normalizeSessionSettings(settings) {
    return normalizeClaudeSessionSettings(settings);
  }

  async handleAskUserQuestion({
    threadId,
    originThreadId = threadId,
    turnId,
    itemId = null,
    toolUseId = null,
    prompt,
    questions = [],
  }) {
    await this.ensureRuntimeStoreLoaded();
    const { pendingAction } = await this.requestPendingAction({
      actionId: `pending-${randomUUID()}`,
      threadId,
      originThreadId,
      turnId,
      itemId,
      kind: 'ask_user_question',
      summary: prompt,
      payload: {
        prompt,
        questions,
        toolUseId,
      },
      waitForResolution: false,
    });

    return createPendingQuestionRecordFromPendingAction(pendingAction);
  }


  async ingestExternalBridgeEvent(payload) {
    return await ingestExternalBridgeEvent(this, payload);
  }

  async handleExternalHookEvent(provider, event) {
    return await handleExternalHookEvent(this, provider, event);
  }

  async handleExternalSessionStart(provider, event) {
    return await handleExternalSessionStart(this, provider, event);
  }

  async handleExternalPermissionRequest(provider, event) {
    return await handleExternalPermissionRequest(this, provider, event);
  }

  async handleExternalPostToolUse(provider, event) {
    return await handleExternalPostToolUse(this, provider, event);
  }

  async handleExternalElicitation(provider, event) {
    return await handleExternalElicitation(this, provider, event);
  }

  async handleExternalElicitationResult(provider, event) {
    return await handleExternalElicitationResult(this, provider, event);
  }

  async handleExternalStop(provider, event) {
    return await handleExternalStop(this, provider, event);
  }

  async handleExternalStopFailure(provider, event) {
    return await handleExternalStopFailure(this, provider, event);
  }

  async prepareExternalHookThread(event) {
    return await prepareExternalHookThread(this, event);
  }

  async buildAcceptedExternalThreadResult(provider, threadRecord, resolution = undefined) {
    return await buildAcceptedExternalThreadResult(this, provider, threadRecord, resolution);
  }

  async resolveExternalPendingActions(threadId, options) {
    return await resolveExternalPendingActions(this, threadId, options);
  }

  async resolveOpenExternalPendingActions(threadId, options = {}) {
    return await resolveOpenExternalPendingActions(this, threadId, options);
  }

  async finalizeExternalPendingAction(pendingAction, options = {}) {
    return await finalizeExternalPendingAction(this, pendingAction, options);
  }

  async ensureExternalBridgeThread(options) {
    return await ensureExternalBridgeThread(this, options);
  }

  async loadProjectThreadMap(projectId, threadIds) {
    return await loadProjectThreadMap(this, projectId, threadIds);
  }

  async syncDiscoveredSessionsForProject(projectId) {
    return await syncDiscoveredSessionsForProject(this, projectId);
  }

  async loadTranscriptThread(threadRecord) {
    return await loadTranscriptThread(this, threadRecord);
  }

  async tryReconcileCompletedTranscript(threadId) {
    return await tryReconcileCompletedTranscript(this, threadId);
  }

  async runTurn(options) {
    return await runTurn(this, options);
  }

  decorateThread(thread, threadRecord = null) {
    return this.decorateThreadWithSharedState(
      attachExternalSessionSnapshot(thread, threadRecord ?? thread),
      {
        includePendingApprovals: true,
        includePendingQuestions: true,
      },
    );
  }

  async reconcileDuplicateSessionThreads(projectId, sessionId = null) {
    return await reconcileDuplicateSessionThreads(this, projectId, sessionId);
  }

  async pruneStaleDiscoveredThreads(projectId, knownThreads, discoveredSessions) {
    return await pruneStaleDiscoveredThreads(this, projectId, knownThreads, discoveredSessions);
  }

  async migrateThreadState(sourceThreadId, targetThreadId = null) {
    return await migrateThreadState(this, sourceThreadId, targetThreadId);
  }

  async findThreadByClaudeSessionId(sessionId) {
    return await findThreadByClaudeSessionId(this, sessionId);
  }

  async syncExternalTranscriptWatcher(options = {}) {
    return await syncExternalTranscriptWatcher(this, options);
  }

  async stopExternalTranscriptWatcher(threadId) {
    return await stopExternalTranscriptWatcher(this, threadId);
  }

  createToolApprovalResolutionResult(pendingAction, resolution) {
    const approved = normalizeToolApprovalDecision(resolution);
    return approved
      ? {
          behavior: 'allow',
          updatedPermissions: resolution?.updatedPermissions,
          toolUseID: pendingAction?.payload?.toolUseId ?? undefined,
        }
      : {
          behavior: 'deny',
          message: normalizeDeniedMessage(resolution),
          toolUseID: pendingAction?.payload?.toolUseId ?? undefined,
        };
  }

  createQuestionResolutionResult(pendingAction, resolution) {
    return createQuestionResponse(pendingAction, resolution);
  }

  publishPendingActionRequested(action) {
    super.publishPendingActionRequested(action);
    if (action?.kind === 'ask_user_question') {
      this.publishRuntimeReconciled(action.threadId, this.runtimeByThread.get(action.threadId));
    }
  }

  publishPendingActionResolved(action) {
    super.publishPendingActionResolved(action);
    if (action?.kind === 'ask_user_question') {
      this.publishRuntimeReconciled(action.threadId, this.runtimeByThread.get(action.threadId));
    }
  }

}
