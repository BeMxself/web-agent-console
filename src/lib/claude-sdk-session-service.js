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
    await this.ensureRuntimeStoreLoaded();
    const ingress = this.externalSessionBridge.ingest(payload);
    if (!ingress.accepted || ingress.ignored) {
      return ingress;
    }

    return await this.handleExternalHookEvent(ingress.provider, ingress.event);
  }

  async handleExternalHookEvent(provider, event) {
    switch (event.hookEventName) {
      case 'SessionStart':
        return await this.handleExternalSessionStart(provider, event);
      case 'PreToolUse':
      case 'PermissionRequest':
        return await this.handleExternalPermissionRequest(provider, event);
      case 'PostToolUse':
        return await this.handleExternalPostToolUse(provider, event);
      case 'Elicitation':
        return await this.handleExternalElicitation(provider, event);
      case 'ElicitationResult':
        return await this.handleExternalElicitationResult(provider, event);
      case 'Stop':
        return await this.handleExternalStop(provider, event);
      case 'StopFailure':
        return await this.handleExternalStopFailure(provider, event);
      default:
        return buildIgnoredResult(provider, 'unsupported_hook_event');
    }
  }

  async handleExternalSessionStart(provider, event) {
    const prepared = await this.prepareExternalHookThread(event);
    if (!prepared) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    return await this.buildAcceptedExternalThreadResult(provider, prepared.threadRecord);
  }

  async handleExternalPermissionRequest(provider, event) {
    const prepared = await this.prepareExternalHookThread(event);
    if (!prepared) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    const { threadRecord, runtime } = prepared;
    const { result } = await this.requestPendingAction({
      actionId: createExternalApprovalId(event),
      threadId: threadRecord.threadId,
      originThreadId: threadRecord.threadId,
      turnId: runtime.activeTurnId,
      itemId: event.toolUseId,
      kind: 'tool_approval',
      summary: summarizePermissionRequest(event),
      payload: {
        approvalKind: event.toolName ?? 'unknown',
        toolUseId: event.toolUseId,
        detail: buildPermissionDetail(event),
      },
      waitForResolution: event.waitForResolution,
    });

    return await this.buildAcceptedExternalThreadResult(provider, threadRecord, result);
  }

  async handleExternalPostToolUse(provider, event) {
    const threadRecord = await this.ensureExternalBridgeThread(event);
    if (!threadRecord) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    await this.resolveExternalPendingActions(threadRecord.threadId, {
      kind: 'tool_approval',
      toolUseId: event.toolUseId,
      status: 'approved',
      resolutionSource: 'external',
    });

    return await this.buildAcceptedExternalThreadResult(provider, threadRecord);
  }

  async handleExternalElicitation(provider, event) {
    const prepared = await this.prepareExternalHookThread(event);
    if (!prepared) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    const { threadRecord, runtime } = prepared;
    const { result } = await this.requestPendingAction({
      actionId: createExternalQuestionId(event),
      threadId: threadRecord.threadId,
      originThreadId: threadRecord.threadId,
      turnId: runtime.activeTurnId,
      itemId: event.toolUseId,
      kind: 'ask_user_question',
      summary: summarizeQuestion(event),
      payload: {
        prompt: summarizeQuestion(event),
        questions: normalizeEventQuestions(event),
        toolUseId: event.toolUseId,
      },
      waitForResolution: event.waitForResolution,
    });

    return await this.buildAcceptedExternalThreadResult(provider, threadRecord, result);
  }

  async handleExternalElicitationResult(provider, event) {
    const threadRecord = await this.ensureExternalBridgeThread(event);
    if (!threadRecord) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    await this.resolveExternalPendingActions(threadRecord.threadId, {
      kind: 'ask_user_question',
      toolUseId: event.toolUseId,
      status: 'answered',
      resolutionSource: 'external',
      response: event.response,
    });

    return await this.buildAcceptedExternalThreadResult(provider, threadRecord);
  }

  async handleExternalStop(provider, event) {
    const threadRecord = await this.ensureExternalBridgeThread(event);
    if (!threadRecord) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    await this.resolveOpenExternalPendingActions(threadRecord.threadId, {
      toolApprovalStatus: 'approved',
      questionStatus: 'answered',
      resolutionSource: 'external',
    });

    const turnId =
      this.runtimeByThread.get(threadRecord.threadId)?.activeTurnId ?? createExternalTurnId(event.sessionId);
    await this.reconcileRuntimeSnapshot(
      threadRecord.threadId,
      createCompletedHookRuntime(this.runtimeByThread.get(threadRecord.threadId)),
      {
        threadStatus: {
          type: 'idle',
        },
        completedTurnId: turnId,
      },
    );
    await this.stopExternalTranscriptWatcher(threadRecord.threadId);

    return await this.buildAcceptedExternalThreadResult(provider, threadRecord);
  }

  async handleExternalStopFailure(provider, event) {
    const threadRecord = await this.ensureExternalBridgeThread(event);
    if (!threadRecord) {
      return buildIgnoredResult(provider, 'unknown_project');
    }

    await this.resolveOpenExternalPendingActions(threadRecord.threadId, {
      toolApprovalStatus: 'denied',
      questionStatus: 'answered',
      resolutionSource: 'external',
      response: event.error,
    });

    await this.reconcileRuntimeSnapshot(
      threadRecord.threadId,
      createErroredHookRuntime(
        this.runtimeByThread.get(threadRecord.threadId),
        event.error ?? 'Claude external session failed',
      ),
      {
        threadStatus: {
          type: 'error',
        },
      },
    );
    await this.stopExternalTranscriptWatcher(threadRecord.threadId);

    return await this.buildAcceptedExternalThreadResult(provider, threadRecord);
  }

  async prepareExternalHookThread(event) {
    let threadRecord = await this.ensureExternalBridgeThread(event);
    if (!threadRecord) {
      return null;
    }

    const runtime = createStartedHookRuntime(this.runtimeByThread.get(threadRecord.threadId), {
      sessionId: event.sessionId,
      turnId: createExternalTurnId(event.sessionId),
    });
    await this.reconcileRuntimeSnapshot(threadRecord.threadId, runtime, {
      threadStatus: {
        type: 'active',
        activeFlags: ['running'],
      },
    });

    threadRecord =
      (await this.syncExternalTranscriptWatcher({
        threadRecord,
        transcriptPath: event.transcriptPath,
        turnId: runtime.activeTurnId,
      })) ?? threadRecord;

    return {
      threadRecord,
      runtime,
    };
  }

  async buildAcceptedExternalThreadResult(provider, threadRecord, resolution = undefined) {
    return {
      accepted: true,
      provider,
      thread: this.decorateThread(createClaudeThreadPlaceholder(threadRecord), threadRecord),
      ...(resolution == null ? {} : { resolution }),
    };
  }

  async resolveExternalPendingActions(
    threadId,
    {
      kind = null,
      toolUseId = null,
      status,
      resolutionSource = 'external',
      response = null,
    },
  ) {
    const matches = [...this.pendingActionsById.values()]
      .map((action) => normalizePendingActionRecord(action))
      .filter((action) => action.threadId === threadId)
      .filter((action) => action.status === 'pending')
      .filter((action) => !kind || action.kind === kind)
      .filter((action) => !toolUseId || action.payload?.toolUseId === toolUseId);

    for (const action of matches) {
      await this.finalizeExternalPendingAction(action, {
        status,
        resolutionSource,
        response,
      });
    }
  }

  async resolveOpenExternalPendingActions(
    threadId,
    {
      toolApprovalStatus = 'approved',
      questionStatus = 'answered',
      resolutionSource = 'external',
      response = null,
    } = {},
  ) {
    const pendingActions = [...this.pendingActionsById.values()]
      .map((action) => normalizePendingActionRecord(action))
      .filter((action) => action.threadId === threadId)
      .filter((action) => action.status === 'pending');

    for (const action of pendingActions) {
      const status = action.kind === 'ask_user_question' ? questionStatus : toolApprovalStatus;
      if (!status) {
        continue;
      }

      await this.finalizeExternalPendingAction(action, {
        status,
        resolutionSource,
        response,
      });
    }
  }

  async finalizeExternalPendingAction(
    pendingAction,
    { status, resolutionSource = 'external', response = null } = {},
  ) {
    const resolution =
      pendingAction.kind === 'ask_user_question'
        ? {
            response,
            resolutionSource,
          }
        : {
            decision: status === 'denied' ? 'denied' : 'approved',
            resolutionSource,
            message: response ?? undefined,
          };
    const resolutionPayload = this.getPendingActionResolutionPayload(pendingAction, resolution);
    const result = this.getPendingActionResolutionResult(pendingAction, resolution, status);
    return await this.finalizePendingAction(pendingAction.id, {
      status,
      resolutionSource,
      result,
      resolutionPayload,
    });
  }

  async ensureExternalBridgeThread({
    sessionId,
    cwd,
    transcriptPath = null,
  }) {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const knownProjectId = normalizeString(cwd);
    const existingThread = await this.findThreadByClaudeSessionId(normalizedSessionId);
    const projectId = existingThread?.projectId ?? knownProjectId;
    if (!projectId) {
      return null;
    }

    const activity = await this.activityStore.load();
    if (!existingThread && !activity.projects?.[projectId]) {
      return null;
    }

    if (activity.projects?.[projectId]?.hidden) {
      await this.activityStore.addProject?.(projectId);
    }

    const timestamp = nowInSeconds();
    return await this.sessionIndex.upsertThread({
      threadId: existingThread?.threadId ?? createImportedClaudeThreadId(normalizedSessionId),
      projectId,
      claudeSessionId: normalizedSessionId,
      summary: existingThread?.summary ?? null,
      bridgeMode: existingThread?.bridgeMode === 'hooked+tail' ? 'hooked+tail' : 'hooked',
      transcriptPath: normalizeString(transcriptPath) ?? existingThread?.transcriptPath ?? null,
      lastSeenAt: timestamp,
      createdAt: existingThread?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  async loadProjectThreadMap(projectId, threadIds) {
    const threadsById = new Map();

    for (const threadId of threadIds) {
      const threadRecord = await this.sessionIndex.readThread(threadId);
      if (!threadRecord) {
        continue;
      }

      threadsById.set(
        threadId,
        this.decorateThread(createClaudeThreadPlaceholder(threadRecord), threadRecord),
      );
    }

    for (const thread of await this.sessionIndex.listThreadsByProject(projectId)) {
      if (!threadsById.has(thread.threadId)) {
        threadsById.set(
          thread.threadId,
          this.decorateThread(createClaudeThreadPlaceholder(thread), thread),
        );
      }
    }

    return threadsById;
  }

  async syncDiscoveredSessionsForProject(projectId) {
    if (typeof this.claudeSdk.listSessions !== 'function') {
      return;
    }

    let knownThreads = await this.sessionIndex.listThreadsByProject(projectId);
    if (await this.reconcileDuplicateSessionThreads(projectId)) {
      knownThreads = await this.sessionIndex.listThreadsByProject(projectId);
    }
    const discoveredSessions = await this.claudeSdk.listSessions({
      dir: projectId,
    });
    if (await this.pruneStaleDiscoveredThreads(projectId, knownThreads, discoveredSessions)) {
      knownThreads = await this.sessionIndex.listThreadsByProject(projectId);
    }
    const knownThreadsBySessionId = buildKnownThreadsBySessionId(knownThreads);

    for (const sessionInfo of discoveredSessions ?? []) {
      const sessionId = normalizeString(sessionInfo?.sessionId);
      if (!sessionId) {
        continue;
      }

      const knownThread = knownThreadsBySessionId.get(sessionId) ?? null;
      const importedThreadId = createImportedClaudeThreadId(sessionId);
      const isImportedThread = knownThread?.threadId === importedThreadId;
      const discoveredAt = nowInSeconds();
      const discoveredUpdatedAt = normalizeTimestampSeconds(sessionInfo?.lastModified);
      const updatedAt =
        discoveredUpdatedAt ||
        (knownThread == null || isImportedThread ? discoveredAt : knownThread?.updatedAt) ||
        discoveredAt;

      await this.sessionIndex.upsertThread({
        threadId: knownThread?.threadId ?? importedThreadId,
        projectId,
        claudeSessionId: sessionId,
        summary:
          normalizeString(sessionInfo?.customTitle) ??
          normalizeString(sessionInfo?.summary) ??
          normalizeString(sessionInfo?.firstPrompt) ??
          knownThread?.summary,
        ...(knownThread == null || isImportedThread
          ? {
              bridgeMode: knownThread?.bridgeMode ?? 'discovered',
              transcriptPath:
                normalizeString(sessionInfo?.transcriptPath) ??
                knownThread?.transcriptPath ??
                null,
              lastSeenAt: discoveredAt,
            }
          : {}),
        createdAt: knownThread?.createdAt ?? updatedAt,
        updatedAt,
      });
    }
  }

  async loadTranscriptThread(threadRecord) {
    const options = buildSessionLookupOptions(threadRecord);
    const [sessionInfo, messages] = await Promise.all([
      this.claudeSdk.getSessionInfo(threadRecord.claudeSessionId, options),
      this.claudeSdk.getSessionMessages(threadRecord.claudeSessionId, options),
    ]);
    const nextThreadRecord = await this.sessionIndex.upsertThread({
      ...threadRecord,
      summary:
        normalizeString(sessionInfo?.customTitle) ??
        normalizeString(sessionInfo?.summary) ??
        threadRecord.summary,
      createdAt: normalizeTimestampSeconds(sessionInfo?.createdAt) || threadRecord.createdAt,
      updatedAt: normalizeTimestampSeconds(sessionInfo?.lastModified) || nowInSeconds(),
    });

    return {
      sessionInfo,
      messages,
      threadRecord: nextThreadRecord,
      thread: buildClaudeThreadFromTranscript({
        threadRecord: nextThreadRecord,
        sessionInfo,
        messages,
      }),
    };
  }

  async tryReconcileCompletedTranscript(threadId) {
    const threadRecord = await this.sessionIndex.readThread(threadId);
    if (!threadRecord?.claudeSessionId) {
      return null;
    }

    try {
      const transcript = await this.loadTranscriptThread(threadRecord);
      const lastTurn = transcript.thread.turns?.at(-1) ?? null;
      if (!lastTurn || lastTurn.status !== 'completed') {
        return null;
      }

      const transcriptUpdatedAtMs = normalizeTimestampMs(transcript.sessionInfo?.lastModified);
      const knownUpdatedAtMs = normalizeTimestampMs(threadRecord.updatedAt);
      if (transcriptUpdatedAtMs <= knownUpdatedAtMs) {
        return null;
      }

      return transcript.thread;
    } catch {
      return null;
    }
  }

  async runTurn({
    activeTurn,
    abortController,
    settings,
    startDeferred,
    turnRequestOrText,
    threadId,
    threadRecord,
    turnId,
  }) {
    let options = null;
    let mapper = null;
    let resolvedSessionId = threadRecord.claudeSessionId;
    let resultMessage = null;
    let queryHandle = null;
    let iterator = null;

    try {
      const turnRequest = normalizeTurnRequestInput(turnRequestOrText, settings);
      validateClaudeAttachments(turnRequest.attachments);
      options = buildQueryOptions({
        abortController,
        cwd: threadRecord.projectId ?? this.cwd,
        settings: {
          model: turnRequest.model,
          reasoningEffort: turnRequest.reasoningEffort,
        },
        sessionId: threadRecord.claudeSessionId,
        canUseTool: async (toolName, input, toolOptions = {}) => {
          const { result } = await this.requestToolApproval({
            threadId,
            originThreadId: threadId,
            turnId,
            toolUseId: toolOptions?.toolUseID ?? null,
            toolName,
            signal: toolOptions?.signal ?? abortController.signal,
            summary: summarizeClaudeToolApproval(toolName, input, toolOptions),
            detail: {
              input,
              blockedPath: toolOptions?.blockedPath ?? null,
              decisionReason: toolOptions?.decisionReason ?? null,
              title: toolOptions?.title ?? null,
              displayName: toolOptions?.displayName ?? null,
              description: toolOptions?.description ?? null,
              suggestions: toolOptions?.suggestions ?? null,
            },
          });

          return result;
        },
      });
      mapper = new ClaudeSdkEventMapper({
        threadId,
        turnId,
        projectId: threadRecord.projectId,
      });
      queryHandle = this.claudeSdk.query({
        prompt: createClaudePromptStream({
          text: turnRequest.text,
          attachments: turnRequest.attachments,
          sessionId: threadRecord.claudeSessionId,
        }),
        options,
      });
      iterator = queryHandle?.[Symbol.asyncIterator]?.();
      if (!iterator || typeof iterator.next !== 'function') {
        throw new Error('Claude query did not return an async iterable');
      }
      if (resolvedSessionId) {
        startDeferred.resolve();
      }

      for await (const message of queryHandle) {
        const nextSessionId = getQuerySessionId(message);
        if (!resolvedSessionId && nextSessionId) {
          resolvedSessionId = nextSessionId;
          threadRecord = await this.sessionIndex.upsertThread({
            ...threadRecord,
            claudeSessionId: resolvedSessionId,
            updatedAt: nowInSeconds(),
          });
          await this.reconcileDuplicateSessionThreads(
            threadRecord.projectId ?? this.cwd,
            resolvedSessionId,
          );
          threadRecord = await this.sessionIndex.readThread(threadId) ?? threadRecord;
          this.setRuntime(threadId, updateRuntimeSessionId(this.runtimeByThread.get(threadId), resolvedSessionId));
          await this.persistRuntimeSnapshot(threadId);
          startDeferred.resolve();
        }

        if (message.type === 'result') {
          resultMessage = message;
        }

        const askQuestion = extractAskUserQuestionToolUse(message);
        if (askQuestion) {
          const { result } = await this.requestUserQuestion({
            threadId,
            originThreadId: threadId,
            turnId,
            toolUseId: askQuestion.toolUseId,
            signal: abortController.signal,
            prompt: askQuestion.prompt,
            questions: askQuestion.questions,
          });
          await submitAskUserQuestionResponse(queryHandle, {
            sessionId: resolvedSessionId,
            toolUseId: askQuestion.toolUseId,
            toolResult: result,
          });
        }

        for (const event of mapper.map(message)) {
          if (event.type === 'turn_completed') {
            this.setRuntime(threadId, createCompletedRuntimeSnapshot(this.runtimeByThread.get(threadId)));
            await this.persistRuntimeSnapshot(threadId);
            this.publishThreadStatusChanged(threadId, { type: 'idle' });
          }

          this.publishEvent(event);
        }
      }

      if (!resolvedSessionId) {
        throw new Error(`Claude turn did not expose a session id for thread ${threadId}`);
      }

      if (resultMessage?.is_error) {
        throw new Error(resultMessage.errors?.join('; ') || 'Claude turn failed');
      }
    } catch (error) {
      startDeferred.reject(error);
      if (isAbortError(error, abortController)) {
        const interruptedRuntime = createInterruptedRuntimeSnapshot(
          this.runtimeByThread.get(threadId),
          'Claude turn interrupted',
        );
        this.setRuntime(threadId, interruptedRuntime);
        await this.persistRuntimeSnapshot(threadId);
        this.publishThreadStatusChanged(threadId, { type: 'idle' });
        this.publishRuntimeReconciled(threadId, interruptedRuntime);
        return;
      }

      const failedRuntime = createErroredRuntimeSnapshot(
        this.runtimeByThread.get(threadId),
        error?.message ?? 'Claude turn failed',
      );
      this.setRuntime(threadId, failedRuntime);
      await this.persistRuntimeSnapshot(threadId);
      this.publishThreadStatusChanged(threadId, { type: 'error' });
      this.publishRuntimeReconciled(threadId, failedRuntime);
      return;
    } finally {
      await closeClaudeQuery(queryHandle, iterator);
    }
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
    const knownThreads = await this.sessionIndex.listThreadsByProject(projectId);
    const activity = await this.activityStore.load();
    const focusedThreadIds = new Set(activity.projects?.[projectId]?.focusedThreadIds ?? []);
    const duplicatesBySessionId = new Map();

    for (const thread of knownThreads) {
      const knownSessionId = normalizeString(thread?.claudeSessionId);
      if (!knownSessionId) {
        continue;
      }
      if (sessionId && knownSessionId !== sessionId) {
        continue;
      }

      if (!duplicatesBySessionId.has(knownSessionId)) {
        duplicatesBySessionId.set(knownSessionId, []);
      }
      duplicatesBySessionId.get(knownSessionId).push(thread);
    }

    let changed = false;
    for (const duplicates of duplicatesBySessionId.values()) {
      if (duplicates.length <= 1) {
        continue;
      }

      const keeper = duplicates.reduce((best, candidate) =>
        choosePreferredSessionThread(best, candidate),
      );
      for (const duplicate of duplicates) {
        if (!duplicate?.threadId || duplicate.threadId === keeper?.threadId) {
          continue;
        }

        if (focusedThreadIds.has(duplicate.threadId)) {
          await this.activityStore.removeFocusedSession?.(projectId, duplicate.threadId);
          focusedThreadIds.delete(duplicate.threadId);
          if (keeper?.threadId && !focusedThreadIds.has(keeper.threadId)) {
            await this.activityStore.addFocusedSession?.(projectId, keeper.threadId);
            focusedThreadIds.add(keeper.threadId);
          }
        }
        await this.migrateThreadState(duplicate.threadId, keeper?.threadId ?? null);
        await this.sessionIndex.deleteThread?.(duplicate.threadId);
        changed = true;
      }
    }

    return changed;
  }

  async pruneStaleDiscoveredThreads(projectId, knownThreads, discoveredSessions) {
    const activeSessionIds = new Set(
      (discoveredSessions ?? [])
        .map((session) => normalizeString(session?.sessionId))
        .filter(Boolean),
    );
    let changed = false;

    for (const thread of knownThreads ?? []) {
      const sessionId = normalizeString(thread?.claudeSessionId);
      if (!sessionId || activeSessionIds.has(sessionId) || !isPrunableDiscoveredThread(thread)) {
        continue;
      }

      await this.activityStore.removeFocusedSession?.(projectId, thread.threadId);
      await this.migrateThreadState(thread.threadId, null);
      await this.sessionIndex.deleteThread?.(thread.threadId);
      changed = true;
    }

    return changed;
  }

  async migrateThreadState(sourceThreadId, targetThreadId = null) {
    if (!sourceThreadId || sourceThreadId === targetThreadId) {
      return;
    }

    const sourceRuntime = this.runtimeByThread.get(sourceThreadId);
    const targetRuntime = targetThreadId ? this.runtimeByThread.get(targetThreadId) : null;
    if (sourceRuntime) {
      if (targetThreadId && (!targetRuntime || !hasRuntimeSnapshot(targetRuntime))) {
        this.setRuntime(targetThreadId, sourceRuntime);
        await this.persistRuntimeSnapshot(targetThreadId);
      }
      this.runtimeByThread.delete(sourceThreadId);
      await this.runtimeStore.deleteThreadRuntime?.(sourceThreadId);
    }

    const activeTurn = this.activeTurnsByThread.get(sourceThreadId);
    if (activeTurn && targetThreadId && !this.activeTurnsByThread.has(targetThreadId)) {
      this.activeTurnsByThread.set(targetThreadId, activeTurn);
    }
    this.activeTurnsByThread.delete(sourceThreadId);

    const sourceSettings = this.sessionSettingsByThread.get(sourceThreadId);
    const targetSettings = targetThreadId
      ? this.sessionSettingsByThread.get(targetThreadId)
      : null;
    if (sourceSettings) {
      if (targetThreadId && !shouldPersistClaudeSessionSettings(targetSettings)) {
        this.sessionSettingsByThread.set(targetThreadId, cloneSessionSettings(sourceSettings));
        await this.runtimeStore.setThreadSettings?.(targetThreadId, sourceSettings);
      }
      this.sessionSettingsByThread.delete(sourceThreadId);
      await this.runtimeStore.deleteThreadSettings?.(sourceThreadId);
    }

    for (const [actionId, action] of [...this.pendingActionsById.entries()]) {
      const normalized = normalizePendingActionRecord(action);
      const touchesSource =
        normalized.threadId === sourceThreadId || normalized.originThreadId === sourceThreadId;
      if (!touchesSource) {
        continue;
      }

      if (!targetThreadId) {
        this.pendingActionsById.delete(actionId);
        await this.runtimeStore.deletePendingAction?.(actionId);
        continue;
      }

      await this.upsertPendingAction({
        ...normalized,
        threadId: normalized.threadId === sourceThreadId ? targetThreadId : normalized.threadId,
        originThreadId:
          normalized.originThreadId === sourceThreadId
            ? targetThreadId
            : normalized.originThreadId,
      });
    }
  }

  async findThreadByClaudeSessionId(sessionId) {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const idsByProject = await this.sessionIndex.listThreadIdsByProject();
    for (const projectId of idsByProject.keys()) {
      const thread = buildKnownThreadsBySessionId(
        await this.sessionIndex.listThreadsByProject(projectId),
      ).get(normalizedSessionId);
      if (thread) {
        return thread;
      }
    }

    return null;
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

  async syncExternalTranscriptWatcher({
    threadRecord,
    transcriptPath = null,
    turnId = null,
  } = {}) {
    const normalizedPath = normalizeString(transcriptPath);
    if (!threadRecord?.threadId || !normalizedPath || !turnId) {
      return threadRecord;
    }

    const existingWatcher = this.externalTranscriptWatchersByThread.get(threadRecord.threadId) ?? null;
    if (
      existingWatcher?.transcriptPath === normalizedPath &&
      existingWatcher?.turnId === turnId
    ) {
      return await this.sessionIndex.readThread(threadRecord.threadId) ?? threadRecord;
    }

    if (existingWatcher) {
      existingWatcher.watcher.stop();
      this.externalTranscriptWatchersByThread.delete(threadRecord.threadId);
    }

    const watcher = new ClaudeExternalTranscriptWatcher({
      threadId: threadRecord.threadId,
      turnId,
      projectId: threadRecord.projectId,
      transcriptPath: normalizedPath,
      pollIntervalMs: this.externalTranscriptPollMs,
      onEvents: (events) => {
        for (const event of events) {
          this.publishEvent(event);
        }
      },
      onError: async () => {
        const tracked = this.externalTranscriptWatchersByThread.get(threadRecord.threadId);
        if (tracked?.watcher !== watcher) {
          return;
        }
        this.externalTranscriptWatchersByThread.delete(threadRecord.threadId);
        const latestThread = await this.sessionIndex.readThread(threadRecord.threadId);
        if (!latestThread) {
          return;
        }
        await this.sessionIndex.upsertThread({
          ...latestThread,
          bridgeMode: 'hooked',
          transcriptPath: normalizedPath,
        });
      },
    });

    try {
      await watcher.start();
    } catch {
      return threadRecord;
    }

    this.externalTranscriptWatchersByThread.set(threadRecord.threadId, {
      watcher,
      transcriptPath: normalizedPath,
      turnId,
    });

    return await this.sessionIndex.upsertThread({
      ...threadRecord,
      bridgeMode: 'hooked+tail',
      transcriptPath: normalizedPath,
    });
  }

  async stopExternalTranscriptWatcher(threadId) {
    const existingWatcher = this.externalTranscriptWatchersByThread.get(threadId) ?? null;
    if (!existingWatcher) {
      return;
    }

    existingWatcher.watcher.stop();
    this.externalTranscriptWatchersByThread.delete(threadId);

    const threadRecord = await this.sessionIndex.readThread(threadId);
    if (!threadRecord || threadRecord.bridgeMode !== 'hooked+tail') {
      return;
    }

    await this.sessionIndex.upsertThread({
      ...threadRecord,
      bridgeMode: 'hooked',
    });
  }

}

function createThreadStub(threadId, projectId) {
  return {
    id: threadId,
    name: null,
    preview: '',
    cwd: projectId,
    updatedAt: 0,
    turns: [],
  };
}

function createImportedClaudeThreadId(sessionId) {
  return `claude-thread-${sessionId}`;
}

function buildKnownThreadsBySessionId(knownThreads) {
  const knownThreadsBySessionId = new Map();

  for (const thread of knownThreads ?? []) {
    const sessionId = normalizeString(thread?.claudeSessionId);
    if (!sessionId) {
      continue;
    }

    knownThreadsBySessionId.set(
      sessionId,
      choosePreferredSessionThread(knownThreadsBySessionId.get(sessionId) ?? null, thread),
    );
  }

  return knownThreadsBySessionId;
}

function choosePreferredSessionThread(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftImported = isImportedClaudeThread(left);
  const rightImported = isImportedClaudeThread(right);
  if (leftImported !== rightImported) {
    return leftImported ? right : left;
  }

  if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
    return (right.updatedAt ?? 0) > (left.updatedAt ?? 0) ? right : left;
  }

  if ((right.createdAt ?? 0) !== (left.createdAt ?? 0)) {
    return (right.createdAt ?? 0) > (left.createdAt ?? 0) ? right : left;
  }

  return (right.threadId ?? '').localeCompare(left.threadId ?? '') > 0 ? right : left;
}

function isImportedClaudeThread(thread) {
  const sessionId = normalizeString(thread?.claudeSessionId);
  if (!sessionId) {
    return false;
  }

  return thread?.threadId === createImportedClaudeThreadId(sessionId);
}

function isPrunableDiscoveredThread(thread) {
  return isImportedClaudeThread(thread) && normalizeBridgeMode(thread?.bridgeMode) === 'discovered';
}

function buildSessionLookupOptions(threadRecord) {
  return threadRecord?.projectId ? { dir: threadRecord.projectId } : {};
}

function buildQueryOptions({ abortController, canUseTool, cwd, settings, sessionId }) {
  const options = {
    abortController,
    canUseTool,
    cwd,
    includePartialMessages: true,
    settingSources: [...DEFAULT_CLAUDE_SETTING_SOURCES],
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  if (settings?.model) {
    options.model = settings.model;
  }

  if (settings?.reasoningEffort) {
    options.effort = settings.reasoningEffort;
  }

  return options;
}

function getQuerySessionId(message) {
  return (
    normalizeString(message?.session_id) ??
    normalizeString(message?.sessionId) ??
    normalizeString(message?.result?.session_id) ??
    normalizeString(message?.result?.sessionId)
  );
}

function extractAskUserQuestionToolUse(message) {
  const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block?.type !== 'tool_use') {
      continue;
    }

    const toolName = normalizeString(block?.name)?.toLowerCase();
    if (toolName !== 'askuserquestion') {
      continue;
    }

    const questions = Array.isArray(block?.input?.questions) ? block.input.questions : [];
    const prompt =
      normalizeString(questions[0]?.question) ??
      normalizeString(block?.input?.prompt) ??
      'Question';

    return {
      toolUseId: normalizeString(block?.id) ?? `${message?.uuid ?? 'ask-user-question'}:${index}`,
      prompt,
      questions: questions.map((question) => ({
        header: normalizeString(question?.header) ?? '',
        question: normalizeString(question?.question) ?? '',
        options: Array.isArray(question?.options)
          ? question.options.map((option) => ({
              label: normalizeString(option?.label) ?? '',
              description: normalizeString(option?.description) ?? '',
              preview: normalizeString(option?.preview),
            }))
          : [],
        multiSelect: Boolean(question?.multiSelect),
      })),
    };
  }

  return null;
}

async function submitAskUserQuestionResponse(queryHandle, { sessionId, toolUseId, toolResult }) {
  if (typeof queryHandle?.streamInput !== 'function') {
    throw new Error('Claude query does not support streaming tool responses');
  }

  await queryHandle.streamInput(createSingleMessageStream({
    type: 'user',
    message: {
      role: 'user',
      content: [],
    },
    parent_tool_use_id: toolUseId,
    tool_use_result: toolResult,
    isSynthetic: true,
    session_id: sessionId,
  }));
}

function createSingleMessageStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
}

function summarizeClaudeToolApproval(toolName, input, toolOptions) {
  const title = normalizeString(toolOptions?.title);
  if (title) {
    return title;
  }

  if (String(toolName ?? '').trim() === 'Bash') {
    const command = Array.isArray(input?.command)
      ? input.command.join(' ')
      : normalizeString(input?.command);
    if (command) {
      return `Run ${command}`;
    }
  }

  const displayName = normalizeString(toolOptions?.displayName);
  if (displayName) {
    return `Allow ${displayName}`;
  }

  return `Allow ${String(toolName ?? 'tool').trim() || 'tool'} usage`;
}

async function closeClaudeQuery(queryHandle, iterator) {
  if (typeof queryHandle?.close === 'function') {
    await queryHandle.close();
    return;
  }

  if (typeof iterator?.return === 'function') {
    await iterator.return();
  }
}

function buildIgnoredResult(provider, reason) {
  return {
    accepted: false,
    provider,
    ignored: true,
    reason,
  };
}

function createStartedHookRuntime(runtime, { sessionId, turnId }) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'started';
  nextRuntime.activeTurnId = turnId;
  nextRuntime.source = 'claude-hook';
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'started',
    sessionId,
    lastError: null,
    closeReason: null,
  });
  return nextRuntime;
}

function createCompletedHookRuntime(runtime) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'completed';
  nextRuntime.activeTurnId = null;
  nextRuntime.source = 'claude-hook';
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'completed',
    lastError: null,
    closeReason: 'completed',
  });
  return nextRuntime;
}

function createErroredHookRuntime(runtime, reason) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'errored';
  nextRuntime.activeTurnId = null;
  nextRuntime.source = 'claude-hook';
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'error',
    lastError: reason,
    closeReason: reason,
  });
  return nextRuntime;
}

function attachExternalSessionSnapshot(thread, source) {
  if (!thread?.id) {
    return thread;
  }

  const external = normalizeExternalSessionSnapshot(source?.external ?? source);
  if (!external) {
    const { external: _external, ...rest } = thread;
    return rest;
  }

  return {
    ...thread,
    external,
  };
}

function normalizeExternalSessionSnapshot(source) {
  const bridgeMode = normalizeBridgeMode(source?.bridgeMode);
  const runtimeSource =
    normalizeString(source?.runtimeSource) ?? getExternalRuntimeSource(bridgeMode);
  const transcriptPath = normalizeString(source?.transcriptPath);
  const lastSeenAt = normalizeTimestampSeconds(source?.lastSeenAt);

  if (!bridgeMode && !runtimeSource && !transcriptPath && !lastSeenAt) {
    return null;
  }

  return {
    ...(bridgeMode ? { bridgeMode } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  };
}

function normalizeBridgeMode(value) {
  const normalized = normalizeString(value);
  if (normalized === 'discovered' || normalized === 'hooked' || normalized === 'hooked+tail') {
    return normalized;
  }

  return null;
}

function getExternalRuntimeSource(bridgeMode) {
  if (bridgeMode === 'discovered') {
    return 'claude-discovered';
  }

  if (bridgeMode === 'hooked' || bridgeMode === 'hooked+tail') {
    return 'claude-external-bridge';
  }

  return null;
}

function createDeferred() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    rejectPromise = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function createQuestionResponse(pendingAction, resolution) {
  const questions = Array.isArray(pendingAction?.payload?.questions) && pendingAction.payload.questions.length > 0
    ? pendingAction.payload.questions
    : [
        {
          header: '',
          question: pendingAction?.payload?.prompt ?? pendingAction?.summary ?? 'Question',
          options: [],
          multiSelect: false,
        },
      ];

  return {
    questions,
    answers: normalizeQuestionAnswers(questions, resolution),
    ...(resolution?.annotations && typeof resolution.annotations === 'object'
      ? { annotations: resolution.annotations }
      : {}),
  };
}

function normalizeQuestionAnswers(questions, resolution) {
  if (resolution?.answers && typeof resolution.answers === 'object' && !Array.isArray(resolution.answers)) {
    return { ...resolution.answers };
  }

  if (questions.length === 1 && resolution?.response != null) {
    return {
      [questions[0].question]: String(resolution.response),
    };
  }

  return {};
}

function normalizeToolApprovalDecision(resolution) {
  if (resolution?.status === 'denied' || resolution?.decision === 'denied' || resolution?.allow === false) {
    return false;
  }

  return true;
}

function normalizeDeniedMessage(resolution) {
  const normalized = String(resolution?.message ?? '').trim();
  return normalized || 'User denied tool approval';
}

function isAbortError(error, abortController) {
  return abortController?.signal?.aborted || error?.name === 'AbortError';
}

function isActiveExternalHookRuntime(runtime) {
  const normalized = normalizeRuntimeSnapshot(runtime);
  return normalized.source === 'claude-hook' && isRuntimeSnapshotActive(normalized);
}

function normalizeSessionModel(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'sonnet' || normalized === 'opus' || normalized === 'haiku') {
    return normalized;
  }

  return null;
}

function normalizeSessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }

  return null;
}

function normalizeClaudeSessionSettings(settings) {
  return {
    model: normalizeSessionModel(settings?.model),
    reasoningEffort: normalizeSessionReasoningEffort(settings?.reasoningEffort),
  };
}

function shouldPersistClaudeSessionSettings(settings) {
  const normalized = normalizeClaudeSessionSettings(settings);
  return Boolean(normalized.model || normalized.reasoningEffort);
}

function normalizeString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeTimestampMs(value) {
  const numericValue = Number(value ?? 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  return numericValue > 1_000_000_000_000 ? Math.floor(numericValue) : Math.floor(numericValue * 1000);
}

function normalizeTimestampSeconds(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric > 9_999_999_999) {
    return Math.floor(numeric / 1000);
  }

  return Math.floor(numeric);
}

function compareProjects(left, right) {
  if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  }

  return left.displayName.localeCompare(right.displayName);
}
