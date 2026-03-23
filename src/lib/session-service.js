import { basename } from 'node:path';
import {
  clonePendingActionRecord,
  createApprovalRecordFromPendingAction,
  createPendingQuestionRecordFromPendingAction,
  listPendingApprovalsFromPendingActions,
  listPendingQuestionsFromPendingActions,
  normalizeApprovalMode,
  normalizePendingActionRecord,
} from './runtime-store.js';


import {
  DEFAULT_SESSION_OPTIONS,
  attachRuntimeSnapshot,
  attachSessionSettings,
  attachPendingActionSnapshot,
  normalizeRuntimeSnapshot,
  normalizeRuntimeRealtimeState,
  hasRuntimeSnapshot,
  shouldPersistRuntimeSnapshot,
  isRuntimeSnapshotActive,
  createStartedRuntimeSnapshot,
  createInterruptingRuntimeSnapshot,
  createInterruptedRuntimeSnapshot,
  createErroredRuntimeSnapshot,
  createCompletedRuntimeSnapshot,
  updateRuntimeSessionId,
  createRuntimeRealtimeState,
  createDefaultSessionSettings,
  normalizeSessionSettings,
  cloneSessionSettings,
  cloneSessionOptions,
  normalizeProviderId,
  normalizeAttachmentCapabilities,
  normalizeRuntimeContext,
  normalizeRuntimeSandboxMode,
  normalizeNonNegativeInteger,
  cloneApprovalRecord,
  clonePendingQuestionRecord,
  createApprovalResolution,
  sanitizeThreadStatus,
  applyThreadStatusOverride,
  hasThreadActiveFlag,
  nowInSeconds,
  normalizeRuntimeSource,
  hasRuntimeRealtimeState,
  summarizeRuntimeRealtimeItem,
  normalizeSessionModel,
  normalizeSessionReasoningEffort,
  shouldPersistSessionSettings,
  normalizeApprovalRecord,
  createQuestionResponse,
  normalizeQuestionAnswers,
  normalizeApprovalKind,
  normalizeToolApprovalDecision,
  createAbortError,
  cryptoRandomId,
  createInMemoryActivityStore,
  createInMemoryRuntimeStore,
  ensureActivityProject,
  buildProjects,
  ensureProject,
  buildFocusedSessions,
  sortThreads,
} from './session-service-shared.js';

export class SessionService {
  constructor({
    activityStore = createInMemoryActivityStore(),
    runtimeStore = createInMemoryRuntimeStore(),
    sessionOptions = DEFAULT_SESSION_OPTIONS,
  } = {}) {
    this.activityStore = activityStore;
    this.runtimeStore = runtimeStore;
    this.sessionOptions = cloneSessionOptions(sessionOptions);
    this.subscribers = new Set();
    this.runtimeByThread = new Map();
    this.approvalMode = 'auto-approve';
    this.pendingActionsById = new Map();
    this.pendingActionWaiters = new Map();
    this.sessionSettingsByThread = new Map();
    this.runtimeStoreLoaded = false;
    this.runtimeStoreLoadPromise = this.loadRuntimeStore();
  }

  subscribe(handler) {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  setRuntime(threadId, runtime) {
    const normalizedRuntime = normalizeRuntimeSnapshot(runtime);
    this.runtimeByThread.set(threadId, normalizedRuntime);
    return normalizedRuntime;
  }

  normalizeSessionSettings(settings) {
    return normalizeSessionSettings(settings);
  }

  getApprovalMode() {
    return {
      mode: this.approvalMode,
    };
  }

  async getSessionOptions() {
    await this.ensureRuntimeStoreLoaded();
    return cloneSessionOptions(this.sessionOptions);
  }

  async getSessionSettings(threadId) {
    await this.ensureRuntimeStoreLoaded();
    return cloneSessionSettings(this.sessionSettingsByThread.get(threadId));
  }

  async setSessionSettings(threadId, settings) {
    await this.ensureRuntimeStoreLoaded();
    if (!threadId) {
      return createDefaultSessionSettings();
    }

    const normalizedSettings = this.normalizeSessionSettings(settings);
    if (shouldPersistSessionSettings(normalizedSettings)) {
      this.sessionSettingsByThread.set(threadId, normalizedSettings);
      await this.runtimeStore.setThreadSettings?.(threadId, normalizedSettings);
    } else {
      this.sessionSettingsByThread.delete(threadId);
      await this.runtimeStore.deleteThreadSettings?.(threadId);
    }

    this.onThreadSettingsChanged(threadId, normalizedSettings);
    return cloneSessionSettings(normalizedSettings);
  }

  onThreadSettingsChanged() {}

  async setApprovalMode(mode) {
    await this.ensureRuntimeStoreLoaded();
    this.approvalMode = normalizeApprovalMode(mode);
    await this.runtimeStore.setApprovalMode?.(this.approvalMode);
    this.publishApprovalModeChanged();
    return this.getApprovalMode();
  }

  getPendingAction(actionId) {
    const action = this.pendingActionsById.get(actionId);
    return action ? clonePendingActionRecord(action) : null;
  }

  getApprovalRecord(approvalId) {
    const action = this.pendingActionsById.get(approvalId);
    return action ? cloneApprovalRecord(action) : null;
  }

  listPendingApprovals(threadId = null) {
    return listPendingApprovalsFromPendingActions(this.pendingActionsById, threadId);
  }

  listPendingQuestions(threadId = null) {
    return listPendingQuestionsFromPendingActions(this.pendingActionsById, threadId);
  }

  async upsertPendingAction(action) {
    await this.ensureRuntimeStoreLoaded();
    const normalized = normalizePendingActionRecord(action);
    this.pendingActionsById.set(normalized.id, normalized);
    await this.runtimeStore.setPendingAction?.(normalized.id, normalized);
    return normalized;
  }

  async requestPendingAction({
    actionId = `pending-${cryptoRandomId()}`,
    threadId,
    originThreadId = threadId,
    turnId = null,
    itemId = null,
    kind,
    summary = '',
    payload = {},
    signal = null,
    waitForResolution = true,
    createdAt = nowInSeconds(),
  }) {
    await this.ensureRuntimeStoreLoaded();

    const existingAction = this.getPendingAction(actionId);
    if (existingAction) {
      const result = this.getStoredPendingActionResult(existingAction);
      if (result || !waitForResolution) {
        return {
          pendingAction: existingAction,
          result,
        };
      }

      const waiter = this.pendingActionWaiters.get(actionId) ?? this.createPendingActionWaiter(actionId);
      this.attachAbortSignalToWaiter(waiter, signal, async () => {
        await this.abortPendingAction(actionId, {
          message:
            existingAction.kind === 'ask_user_question'
              ? 'Turn interrupted while waiting for user input'
              : 'Turn interrupted while waiting for tool approval',
          status: existingAction.kind === 'ask_user_question' ? 'answered' : 'denied',
        });
      });
      return {
        pendingAction: existingAction,
        result: await waiter.promise,
      };
    }

    const waiter = waitForResolution ? this.createPendingActionWaiter(actionId) : null;
    let pendingAction = null;

    try {
      pendingAction = await this.upsertPendingAction({
        id: actionId,
        threadId,
        originThreadId,
        turnId,
        itemId,
        kind,
        summary,
        payload,
        status: 'pending',
        createdAt,
      });
    } catch (error) {
      waiter?.cleanup();
      throw error;
    }

    if (kind === 'tool_approval' && this.approvalMode === 'auto-approve') {
      waiter?.cleanup();
      return await this.finalizePendingAction(actionId, {
        status: 'auto-approved',
        resolutionSource: 'auto',
        result: this.createToolApprovalResolutionResult(
          pendingAction,
          { decision: 'approved' },
          'auto-approved',
        ),
      });
    }

    this.publishPendingActionRequested(pendingAction);
    if (!waitForResolution) {
      return {
        pendingAction,
        result: null,
      };
    }

    this.attachAbortSignalToWaiter(waiter, signal, async () => {
      await this.abortPendingAction(actionId, {
        message:
          kind === 'ask_user_question'
            ? 'Turn interrupted while waiting for user input'
            : 'Turn interrupted while waiting for tool approval',
        status: kind === 'ask_user_question' ? 'answered' : 'denied',
      });
    });

    return {
      pendingAction,
      result: await waiter.promise,
    };
  }

  async requestToolApproval({
    threadId,
    originThreadId = threadId,
    turnId = null,
    itemId = null,
    toolUseId = null,
    toolName = 'unknown',
    summary = '',
    detail = {},
    signal = null,
  }) {
    return await this.requestPendingAction({
      threadId,
      originThreadId,
      turnId,
      itemId,
      kind: 'tool_approval',
      summary,
      payload: {
        approvalKind: normalizeApprovalKind(toolName),
        detail,
        toolUseId,
      },
      signal,
    });
  }

  async requestUserQuestion({
    threadId,
    originThreadId = threadId,
    turnId = null,
    itemId = null,
    toolUseId = null,
    prompt = '',
    questions = [],
    signal = null,
  }) {
    return await this.requestPendingAction({
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
      signal,
    });
  }

  createPendingActionWaiter(actionId) {
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    let abortSignal = null;
    let abortHandler = null;

    const cleanup = () => {
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      abortSignal = null;
      abortHandler = null;
      if (this.pendingActionWaiters.get(actionId) === waiter) {
        this.pendingActionWaiters.delete(actionId);
      }
    };

    const waiter = {
      promise: new Promise((resolve, reject) => {
        resolvePromise = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        };
        rejectPromise = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };
      }),
      resolve(value) {
        resolvePromise(value);
      },
      reject(error) {
        rejectPromise(error);
      },
      cleanup,
    };

    this.pendingActionWaiters.set(actionId, waiter);
    return waiter;
  }

  attachAbortSignalToWaiter(waiter, signal, onAbort) {
    if (!signal || !waiter) {
      return;
    }

    if (signal.aborted) {
      void onAbort();
      return;
    }

    const abortHandler = () => {
      void onAbort();
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    const originalCleanup = waiter.cleanup;
    waiter.cleanup = () => {
      signal.removeEventListener('abort', abortHandler);
      originalCleanup();
    };
  }

  async resolvePendingAction(actionId, resolution, resolutionSource = 'user') {
    await this.ensureRuntimeStoreLoaded();
    const pendingAction = this.getPendingAction(actionId);
    if (!pendingAction || pendingAction.status !== 'pending') {
      throw new Error(`pending action not found: ${actionId}`);
    }

    const nextStatus = this.getPendingActionResolutionStatus(pendingAction, resolution);
    const resolutionPayload = this.getPendingActionResolutionPayload(pendingAction, resolution);
    const result = this.getPendingActionResolutionResult(pendingAction, resolution, nextStatus);
    const { pendingAction: resolvedAction } = await this.finalizePendingAction(actionId, {
      status: nextStatus,
      resolutionSource,
      result,
      resolutionPayload,
    });
    return clonePendingActionRecord(resolvedAction);
  }

  getPendingActionResolutionStatus(pendingAction, resolution) {
    if (pendingAction?.kind === 'tool_approval') {
      return normalizeToolApprovalDecision(resolution) ? 'approved' : 'denied';
    }

    return 'answered';
  }

  getPendingActionResolutionPayload(pendingAction, resolution) {
    if (pendingAction?.kind !== 'ask_user_question') {
      return pendingAction?.payload ?? {};
    }

    return {
      ...pendingAction.payload,
      response: resolution?.response ?? null,
      answers: resolution?.answers ?? null,
      annotations: resolution?.annotations ?? null,
    };
  }

  getPendingActionResolutionResult(pendingAction, resolution, status) {
    if (pendingAction?.kind === 'tool_approval') {
      return this.createToolApprovalResolutionResult(pendingAction, resolution, status);
    }

    return this.createQuestionResolutionResult(pendingAction, resolution);
  }

  getStoredPendingActionResult(pendingAction) {
    if (!pendingAction || pendingAction.status === 'pending') {
      return null;
    }

    if (pendingAction.kind === 'tool_approval') {
      return this.getPendingActionResolutionResult(
        pendingAction,
        {
          decision:
            pendingAction.status === 'approved' || pendingAction.status === 'auto-approved'
              ? 'approved'
              : 'denied',
          resolutionSource: pendingAction.resolutionSource ?? 'user',
          message: pendingAction.payload?.message ?? null,
        },
        pendingAction.status,
      );
    }

    return this.getPendingActionResolutionResult(
      pendingAction,
      {
        response: pendingAction.payload?.response ?? null,
        answers: pendingAction.payload?.answers ?? null,
        annotations: pendingAction.payload?.annotations ?? null,
        resolutionSource: pendingAction.resolutionSource ?? 'user',
      },
      pendingAction.status,
    );
  }

  createToolApprovalResolutionResult(pendingAction, resolution, status) {
    return createApprovalResolution({
      ...pendingAction,
      status,
      resolutionSource: resolution?.resolutionSource ?? 'user',
    });
  }

  createQuestionResolutionResult(pendingAction, resolution) {
    return createQuestionResponse(pendingAction, resolution);
  }

  async finalizePendingAction(
    actionId,
    { status, resolutionSource, result = null, resolutionPayload = null } = {},
  ) {
    const pendingAction = this.getPendingAction(actionId);
    if (!pendingAction) {
      throw new Error(`pending action not found: ${actionId}`);
    }

    const resolvedAction = await this.upsertPendingAction({
      ...pendingAction,
      status,
      resolvedAt: nowInSeconds(),
      resolutionSource,
      payload: resolutionPayload ?? pendingAction.payload,
    });

    const waiter = this.pendingActionWaiters.get(actionId);
    if (waiter) {
      waiter.resolve(result);
    }

    this.publishPendingActionResolved(resolvedAction);
    return {
      pendingAction: resolvedAction,
      result,
    };
  }

  async abortPendingAction(actionId, { message = 'Turn interrupted', status = null } = {}) {
    const pendingAction = this.getPendingAction(actionId);
    const waiter = this.pendingActionWaiters.get(actionId);
    if (!pendingAction || pendingAction.status !== 'pending') {
      waiter?.reject(createAbortError(message));
      return pendingAction;
    }

    const resolvedAction = await this.upsertPendingAction({
      ...pendingAction,
      status: status ?? (pendingAction.kind === 'tool_approval' ? 'denied' : 'answered'),
      resolvedAt: nowInSeconds(),
      resolutionSource: 'abort',
    });

    waiter?.reject(createAbortError(message));
    this.publishPendingActionResolved(resolvedAction);
    return resolvedAction;
  }

  async approveRequest(approvalId) {
    const approval = await this.resolvePendingAction(approvalId, { decision: 'approved' });
    return createApprovalResolution(approval);
  }

  async denyRequest(approvalId) {
    const approval = await this.resolvePendingAction(approvalId, { decision: 'denied' });
    return createApprovalResolution(approval);
  }

  async reconcileRuntimeSnapshot(
    threadId,
    runtime,
    { threadStatus = null, completedTurnId = null } = {},
  ) {
    await this.ensureRuntimeStoreLoaded();
    const previousRuntime = normalizeRuntimeSnapshot(this.runtimeByThread.get(threadId));
    const shouldPublishCompletedTurn = completedTurnId && isRuntimeSnapshotActive(previousRuntime);
    const nextRuntime = this.setRuntime(threadId, runtime);
    await this.persistRuntimeSnapshot(threadId);
    if (threadStatus) {
      this.publishThreadStatusChanged(threadId, threadStatus);
    }
    if (shouldPublishCompletedTurn) {
      this.publishEvent({
        type: 'turn_completed',
        threadId,
        payload: {
          threadId,
          turnId: completedTurnId,
        },
      });
    }
    this.publishRuntimeReconciled(threadId, nextRuntime);
    return nextRuntime;
  }

  decorateThreadWithSharedState(
    thread,
    { includePendingApprovals = true, includePendingQuestions = includePendingApprovals } = {},
  ) {
    const threadWithRuntime = attachRuntimeSnapshot(thread, this.runtimeByThread.get(thread?.id));
    const threadWithSettings = attachSessionSettings(
      threadWithRuntime,
      this.sessionSettingsByThread.get(thread?.id),
    );
    return attachPendingActionSnapshot(threadWithSettings, {
      pendingApprovals: this.listPendingApprovals(thread?.id),
      pendingQuestions: this.listPendingQuestions(thread?.id),
      includePendingApprovals,
      includePendingQuestions,
    });
  }

  async loadRuntimeStore() {
    const snapshot = await this.runtimeStore?.load?.().catch(() => ({ threads: {} }));
    this.approvalMode = normalizeApprovalMode(snapshot?.approvalMode);
    this.pendingActionsById = new Map(
      Object.entries(snapshot?.pendingActions ?? {}).map(([actionId, action]) => [
        actionId,
        normalizePendingActionRecord(action),
      ]),
    );
    this.sessionSettingsByThread = new Map(
      Object.entries(snapshot?.threadSettings ?? {}).map(([threadId, settings]) => [
        threadId,
        this.normalizeSessionSettings(settings),
      ]),
    );
    const storedRuntimeEntries = Object.entries(snapshot?.threads ?? {}).map(([threadId, runtime]) => [
      threadId,
      normalizeRuntimeSnapshot(runtime),
    ]);
    this.runtimeByThread = new Map([...storedRuntimeEntries, ...this.runtimeByThread]);
    this.runtimeStoreLoaded = true;
    return this.runtimeByThread;
  }

  async ensureRuntimeStoreLoaded() {
    if (this.runtimeStoreLoaded) {
      return;
    }

    await this.runtimeStoreLoadPromise;
  }

  async persistRuntimeSnapshot(threadId) {
    await this.ensureRuntimeStoreLoaded();
    if (!threadId || !this.runtimeStore) {
      return;
    }

    const runtime = normalizeRuntimeSnapshot(this.runtimeByThread.get(threadId));
    if (shouldPersistRuntimeSnapshot(runtime)) {
      await this.runtimeStore.setThreadRuntime?.(threadId, runtime);
      return;
    }

    await this.runtimeStore.deleteThreadRuntime?.(threadId);
  }

  publishEvent(event) {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  publishThreadStatusChanged(threadId, status) {
    this.publishEvent({
      type: 'thread_status_changed',
      threadId,
      payload: {
        threadId,
        status,
      },
    });
  }

  publishRuntimeReconciled(threadId, runtime) {
    this.publishEvent({
      type: 'session_runtime_reconciled',
      threadId,
      payload: {
        threadId,
        runtime: normalizeRuntimeSnapshot(runtime),
      },
    });
  }

  publishPendingActionRequested(action) {
    if (action?.kind === 'ask_user_question') {
      const question = createPendingQuestionRecordFromPendingAction(action);
      if (question) {
        this.publishEvent({
          type: 'pending_question_requested',
          threadId: question.threadId,
          payload: {
            question,
          },
        });
      }
      return;
    }

    const approval = createApprovalRecordFromPendingAction(action);
    if (!approval) {
      return;
    }

    this.publishEvent({
      type: 'approval_requested',
      threadId: approval.threadId,
      payload: {
        approval,
      },
    });
  }

  publishPendingActionResolved(action) {
    if (action?.kind === 'ask_user_question') {
      const question = createPendingQuestionRecordFromPendingAction(action);
      if (question) {
        this.publishEvent({
          type: 'pending_question_resolved',
          threadId: question.threadId,
          payload: {
            question,
          },
        });
      }
      return;
    }

    const approval = createApprovalRecordFromPendingAction(action);
    if (!approval) {
      return;
    }

    this.publishEvent({
      type: 'approval_resolved',
      threadId: approval.threadId,
      payload: {
        approval,
      },
    });
  }

  publishApprovalModeChanged() {
    this.publishEvent({
      type: 'approval_mode_changed',
      threadId: null,
      payload: this.getApprovalMode(),
    });
  }

  persistApprovalRecordLater(approval) {
    void this.ensureRuntimeStoreLoaded()
      .then(() => this.runtimeStore.setPendingAction?.(approval.id, approval))
      .catch(() => {});
  }
}


export * from './session-service-shared.js';
