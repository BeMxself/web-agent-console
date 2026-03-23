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

export const DEFAULT_SESSION_OPTIONS = Object.freeze({
  providerId: 'codex',
  attachmentCapabilities: Object.freeze({
    maxAttachments: 10,
    maxBytesPerAttachment: 20 * 1024 * 1024,
    acceptedMimePatterns: Object.freeze(['image/*']),
    supportsNonImageFiles: false,
  }),
  modelOptions: Object.freeze([
    Object.freeze({ value: '', label: '默认' }),
    Object.freeze({ value: 'gpt-5.4', label: 'gpt-5.4' }),
    Object.freeze({ value: 'gpt-5.2', label: 'gpt-5.2' }),
    Object.freeze({ value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' }),
    Object.freeze({ value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' }),
  ]),
  reasoningEffortOptions: Object.freeze([
    Object.freeze({ value: '', label: '默认' }),
    Object.freeze({ value: 'low', label: '低' }),
    Object.freeze({ value: 'medium', label: '中' }),
    Object.freeze({ value: 'high', label: '高' }),
    Object.freeze({ value: 'xhigh', label: '极高' }),
  ]),
  defaults: Object.freeze({
    model: null,
    reasoningEffort: null,
  }),
});

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

export function attachRuntimeSnapshot(thread, runtime) {
  if (!thread?.id) {
    return thread;
  }

  const snapshot = normalizeRuntimeSnapshot(runtime);
  if (!hasRuntimeSnapshot(snapshot)) {
    const { runtime: _runtime, ...rest } = thread;
    return rest;
  }

  return {
    ...thread,
    runtime: snapshot,
  };
}

export function attachSessionSettings(thread, settings) {
  if (!thread?.id) {
    return thread;
  }

  return {
    ...thread,
    settings: cloneSessionSettings(settings),
  };
}

export function attachPendingActionSnapshot(
  thread,
  {
    pendingApprovals = [],
    pendingQuestions = [],
    includePendingApprovals = false,
    includePendingQuestions = false,
  } = {},
) {
  if (!thread?.id) {
    return thread;
  }

  const nextThread = {
    ...thread,
    pendingApprovalCount: pendingApprovals.length,
    pendingQuestionCount: pendingQuestions.length,
    waitingOnApproval:
      pendingApprovals.length > 0 || hasThreadActiveFlag(thread?.status, 'waitingOnApproval'),
  };

  const withApprovals = includePendingApprovals
    ? {
        ...nextThread,
        pendingApprovals: pendingApprovals.map((approval) => cloneApprovalRecord(approval)),
      }
    : nextThread;

  if (!includePendingQuestions) {
    const { pendingQuestions: _pendingQuestions, ...rest } = withApprovals;
    return rest;
  }

  return {
    ...withApprovals,
    pendingQuestions: pendingQuestions.map((question) => clonePendingQuestionRecord(question)),
  };
}

export function normalizeRuntimeSnapshot(runtime) {
  const nextRuntime = {
    turnStatus: runtime?.turnStatus ?? 'idle',
    activeTurnId: runtime?.activeTurnId ?? null,
    diff: runtime?.diff ?? null,
    realtime: normalizeRuntimeRealtimeState(runtime?.realtime),
  };

  nextRuntime.source = hasRuntimeSnapshot(nextRuntime)
    ? normalizeRuntimeSource(runtime?.source)
    : null;

  return nextRuntime;
}

export function normalizeRuntimeRealtimeState(realtime) {
  return createRuntimeRealtimeState({
    ...realtime,
    items: (realtime?.items ?? []).map((item, index) => ({
      index: item?.index ?? index + 1,
      summary: item?.summary ?? summarizeRuntimeRealtimeItem(item?.value),
      value: item?.value,
    })),
    audioChunkCount: Number(realtime?.audioChunkCount ?? 0),
    audioByteCount: Number(realtime?.audioByteCount ?? 0),
    lastAudio: realtime?.lastAudio
      ? {
          sampleRate: realtime.lastAudio.sampleRate ?? null,
          numChannels: realtime.lastAudio.numChannels ?? null,
          samplesPerChannel: realtime.lastAudio.samplesPerChannel ?? null,
        }
      : null,
  });
}

export function hasRuntimeSnapshot(runtime) {
  return Boolean(
    runtime.turnStatus !== 'idle' ||
      runtime.activeTurnId ||
      runtime.diff ||
      hasRuntimeRealtimeState(runtime.realtime),
  );
}

export function shouldPersistRuntimeSnapshot(runtime) {
  return runtime.turnStatus === 'interrupted' || runtime.turnStatus === 'errored' || isRuntimeSnapshotActive(runtime);
}

export function isRuntimeSnapshotActive(runtime) {
  return Boolean(
    runtime.turnStatus === 'started' ||
      runtime.turnStatus === 'interrupting' ||
      runtime.activeTurnId ||
      runtime.realtime.status === 'started',
  );
}

export function createStartedRuntimeSnapshot({ runtime, turnId, sessionId }) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'started';
  nextRuntime.activeTurnId = turnId;
  nextRuntime.source = 'appServer';
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'started',
    sessionId: sessionId ?? nextRuntime.realtime.sessionId,
    lastError: null,
    closeReason: null,
  });
  return nextRuntime;
}

export function createInterruptingRuntimeSnapshot(runtime) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'interrupting';
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'started',
  });
  return nextRuntime;
}

export function createInterruptedRuntimeSnapshot(runtime, reason) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'interrupted';
  nextRuntime.activeTurnId = null;
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'interrupted',
    lastError: reason,
    closeReason: reason,
  });
  return nextRuntime;
}

export function createErroredRuntimeSnapshot(runtime, reason) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'errored';
  nextRuntime.activeTurnId = null;
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'error',
    lastError: reason,
    closeReason: reason,
  });
  return nextRuntime;
}

export function createCompletedRuntimeSnapshot(runtime) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.turnStatus = 'completed';
  nextRuntime.activeTurnId = null;
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    status: 'completed',
    lastError: null,
    closeReason: 'completed',
  });
  return nextRuntime;
}

export function updateRuntimeSessionId(runtime, sessionId) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  nextRuntime.realtime = normalizeRuntimeRealtimeState({
    ...nextRuntime.realtime,
    sessionId,
  });
  return nextRuntime;
}

export function createRuntimeRealtimeState(overrides = {}) {
  return {
    status: 'idle',
    sessionId: null,
    items: [],
    audioChunkCount: 0,
    audioByteCount: 0,
    lastAudio: null,
    lastError: null,
    closeReason: null,
    ...overrides,
  };
}

export function createDefaultSessionSettings() {
  return {
    model: null,
    reasoningEffort: null,
  };
}

export function normalizeSessionSettings(settings) {
  return {
    model: normalizeSessionModel(settings?.model),
    reasoningEffort: normalizeSessionReasoningEffort(settings?.reasoningEffort),
  };
}

export function cloneSessionSettings(settings) {
  const normalized = normalizeSessionSettings(settings);
  return {
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
  };
}

export function cloneSessionOptions(options) {
  const cloned = {
    modelOptions: (options?.modelOptions ?? []).map((option) => ({
      value: option?.value ?? '',
      label: option?.label ?? '',
    })),
    reasoningEffortOptions: (options?.reasoningEffortOptions ?? []).map((option) => ({
      value: option?.value ?? '',
      label: option?.label ?? '',
    })),
    defaults: cloneSessionSettings(options?.defaults),
  };

  const providerId = normalizeProviderId(options?.providerId);
  if (providerId) {
    cloned.providerId = providerId;
  }

  if (options && Object.prototype.hasOwnProperty.call(options, 'attachmentCapabilities')) {
    const attachmentCapabilities = normalizeAttachmentCapabilities(options?.attachmentCapabilities);
    cloned.attachmentCapabilities = {
      maxAttachments: attachmentCapabilities.maxAttachments,
      maxBytesPerAttachment: attachmentCapabilities.maxBytesPerAttachment,
      acceptedMimePatterns: [...attachmentCapabilities.acceptedMimePatterns],
      supportsNonImageFiles: attachmentCapabilities.supportsNonImageFiles,
    };
  }

  const runtimeContext = normalizeRuntimeContext(options?.runtimeContext);
  if (runtimeContext) {
    cloned.runtimeContext = runtimeContext;
  }

  return cloned;
}

function normalizeProviderId(providerId) {
  if (typeof providerId !== 'string') {
    return null;
  }

  const normalized = providerId.trim();
  return normalized || null;
}

function normalizeAttachmentCapabilities(capabilities) {
  const maxAttachments = normalizeNonNegativeInteger(capabilities?.maxAttachments, 0);
  const maxBytesPerAttachment = normalizeNonNegativeInteger(capabilities?.maxBytesPerAttachment, 0);
  const acceptedMimePatterns = Array.isArray(capabilities?.acceptedMimePatterns)
    ? capabilities.acceptedMimePatterns
        .filter((pattern) => typeof pattern === 'string')
        .map((pattern) => pattern.trim())
        .filter(Boolean)
    : [];

  return {
    maxAttachments,
    maxBytesPerAttachment,
    acceptedMimePatterns,
    supportsNonImageFiles: Boolean(capabilities?.supportsNonImageFiles),
  };
}

function normalizeRuntimeContext(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    return null;
  }

  const sandboxMode = normalizeRuntimeSandboxMode(runtimeContext.sandboxMode);
  if (!sandboxMode) {
    return null;
  }

  return {
    sandboxMode,
  };
}

function normalizeRuntimeSandboxMode(sandboxMode) {
  if (typeof sandboxMode !== 'string') {
    return null;
  }

  const normalizedSandboxMode = sandboxMode.trim();
  if (!normalizedSandboxMode) {
    return null;
  }

  switch (normalizedSandboxMode) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return normalizedSandboxMode;
    default:
      return null;
  }
}

function normalizeNonNegativeInteger(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fallback;
  }

  return value;
}

export function cloneApprovalRecord(approval) {
  if (!approval) {
    return approval;
  }

  return createApprovalRecordFromPendingAction(approval) ?? normalizeApprovalRecord(approval);
}

export function clonePendingQuestionRecord(question) {
  if (!question) {
    return question;
  }

  return createPendingQuestionRecordFromPendingAction(question) ?? {
    ...question,
  };
}

export function createApprovalResolution(approval) {
  return {
    decision:
      approval?.status === 'approved' || approval?.status === 'auto-approved'
        ? 'approved'
        : 'denied',
  };
}

export function sanitizeThreadStatus(status) {
  if (!status || typeof status !== 'object') {
    return { type: 'idle' };
  }

  if (status.type === 'active') {
    return {
      type: 'active',
      activeFlags: Array.isArray(status.activeFlags)
        ? status.activeFlags.filter((flag) => typeof flag === 'string')
        : [],
    };
  }

  return {
    type: status.type ?? 'idle',
  };
}

export function applyThreadStatusOverride(thread, threadStatusById) {
  if (!thread?.id) {
    return thread;
  }

  const nextStatus = threadStatusById.get(thread.id);
  if (!nextStatus) {
    return thread;
  }

  return {
    ...thread,
    status: sanitizeThreadStatus(nextStatus),
  };
}

export function hasThreadActiveFlag(status, flag) {
  return status?.type === 'active' && Array.isArray(status.activeFlags) && status.activeFlags.includes(flag);
}

export function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeRuntimeSource(source) {
  if (source === 'externalRollout' || source === 'claude-hook') {
    return source;
  }

  return 'appServer';
}

function hasRuntimeRealtimeState(realtime) {
  return Boolean(
    realtime.sessionId ||
      realtime.items.length ||
      realtime.audioChunkCount > 0 ||
      realtime.lastError ||
      realtime.closeReason ||
      realtime.status !== 'idle',
  );
}

function summarizeRuntimeRealtimeItem(value) {
  if (value == null) {
    return 'unknown';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (typeof value === 'object') {
    if (typeof value.type === 'string' && value.type.trim()) {
      return value.type;
    }

    if (typeof value.event === 'string' && value.event.trim()) {
      return value.event;
    }
  }

  return typeof value;
}

function normalizeSessionModel(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeSessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }

  return null;
}

function shouldPersistSessionSettings(settings) {
  const normalized = normalizeSessionSettings(settings);
  return Boolean(normalized.model || normalized.reasoningEffort);
}

function normalizeApprovalRecord(approval) {
  return {
    id: approval?.id ?? null,
    threadId: approval?.threadId ?? null,
    originThreadId: approval?.originThreadId ?? approval?.threadId ?? null,
    turnId: approval?.turnId ?? null,
    itemId: approval?.itemId ?? null,
    kind: approval?.kind ?? 'unknown',
    summary: approval?.summary ?? '',
    detail:
      approval?.detail && typeof approval.detail === 'object' && !Array.isArray(approval.detail)
        ? { ...approval.detail }
        : {},
    status: approval?.status ?? 'pending',
    createdAt: Number(approval?.createdAt ?? nowInSeconds()),
    resolvedAt:
      approval?.resolvedAt == null
        ? null
        : Number(approval.resolvedAt),
    resolutionSource: approval?.resolutionSource ?? null,
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

function normalizeApprovalKind(toolName) {
  const normalized = String(toolName ?? '').trim();
  return normalized || 'unknown';
}

function normalizeToolApprovalDecision(resolution) {
  if (resolution?.status === 'denied' || resolution?.decision === 'denied' || resolution?.allow === false) {
    return false;
  }

  return true;
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

export function createInMemoryActivityStore() {
  const snapshot = {
    projects: {},
  };

  return {
    async load() {
      return snapshot;
    },
    async addFocusedSession(projectId, threadId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.hidden = false;
      if (!project.focusedThreadIds.includes(threadId)) {
        project.focusedThreadIds.push(threadId);
      }
    },
    async addProject(projectId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.hidden = false;
    },
    async removeFocusedSession(projectId, threadId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.focusedThreadIds = project.focusedThreadIds.filter((id) => id !== threadId);
    },
    async setCollapsed(projectId, collapsed) {
      const project = ensureActivityProject(snapshot, projectId);
      project.collapsed = Boolean(collapsed);
    },
    async hideProject(projectId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.hidden = true;
      project.collapsed = false;
      project.focusedThreadIds = [];
    },
  };
}

export function createInMemoryRuntimeStore() {
  const snapshot = {
    approvalMode: 'auto-approve',
    pendingActions: {},
    threads: {},
    threadSettings: {},
  };

  return {
    async load() {
      return snapshot;
    },
    async setApprovalMode(mode) {
      snapshot.approvalMode = normalizeApprovalMode(mode);
      return snapshot.approvalMode;
    },
    async setApproval(approvalId, approval) {
      return await this.setPendingAction(approvalId, approval);
    },
    async deleteApproval(approvalId) {
      return await this.deletePendingAction(approvalId);
    },
    async setPendingAction(actionId, action) {
      snapshot.pendingActions[actionId] = normalizePendingActionRecord(action);
      return snapshot.pendingActions[actionId];
    },
    async deletePendingAction(actionId) {
      delete snapshot.pendingActions[actionId];
      return null;
    },
    async setThreadRuntime(threadId, runtime) {
      snapshot.threads[threadId] = normalizeRuntimeSnapshot(runtime);
      return snapshot.threads[threadId];
    },
    async deleteThreadRuntime(threadId) {
      delete snapshot.threads[threadId];
      return null;
    },
    async setThreadSettings(threadId, settings) {
      snapshot.threadSettings[threadId] = normalizeSessionSettings(settings);
      return snapshot.threadSettings[threadId];
    },
    async deleteThreadSettings(threadId) {
      delete snapshot.threadSettings[threadId];
      return null;
    },
  };
}

function ensureActivityProject(snapshot, projectId) {
  if (!snapshot.projects[projectId]) {
    snapshot.projects[projectId] = {
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
    };
  }

  return snapshot.projects[projectId];
}

export function buildProjects(activeThreads, archivedThreads, activityProjects, knownThreads = []) {
  const projectsByCwd = new Map();

  for (const thread of activeThreads) {
    ensureProject(projectsByCwd, thread).historySessions.active.push(thread);
  }

  for (const thread of archivedThreads) {
    ensureProject(projectsByCwd, thread).historySessions.archived.push(thread);
  }

  for (const [projectId, project] of Object.entries(activityProjects)) {
    const projectRecord = ensureProject(projectsByCwd, {
      cwd: projectId,
    });
    projectRecord.collapsed = Boolean(project?.collapsed);
    projectRecord.hidden = Boolean(project?.hidden);
    projectRecord.focusedThreadIds = [...(project?.focusedThreadIds ?? [])];
  }

  return [...projectsByCwd.values()]
    .filter((project) => !project.hidden)
    .map((project) => {
      const activeHistory = sortThreads(project.historySessions.active);
      const archivedHistory = sortThreads(project.historySessions.archived);
      const focusedSessions = buildFocusedSessions(project, activeHistory, archivedHistory, knownThreads);
      const focusedIds = new Set(focusedSessions.map((thread) => thread.id));
      const updatedAt = Math.max(
        0,
        ...focusedSessions.map((thread) => thread.updatedAt ?? 0),
        ...activeHistory.map((thread) => thread.updatedAt ?? 0),
        ...archivedHistory.map((thread) => thread.updatedAt ?? 0),
      );

      return {
        id: project.id,
        cwd: project.cwd,
        displayName: project.displayName,
        collapsed: project.collapsed,
        focusedSessions,
        historySessions: {
          active: activeHistory.filter((thread) => !focusedIds.has(thread.id)),
          archived: archivedHistory.filter((thread) => !focusedIds.has(thread.id)),
        },
        updatedAt,
      };
    })
    .sort((left, right) => {
      if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      }

      return left.displayName.localeCompare(right.displayName);
    });
}

function ensureProject(projectsByCwd, thread) {
  const cwd = thread.cwd ?? '__unknown__';
  if (!projectsByCwd.has(cwd)) {
    projectsByCwd.set(cwd, {
      id: cwd,
      cwd: thread.cwd ?? null,
      displayName: thread.cwd ? basename(thread.cwd) : 'Unknown Workspace',
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
      historySessions: {
        active: [],
        archived: [],
      },
      updatedAt: 0,
    });
  }

  return projectsByCwd.get(cwd);
}

function buildFocusedSessions(project, activeHistory, archivedHistory, knownThreads) {
  const threadsById = new Map();

  for (const thread of [...knownThreads, ...activeHistory, ...archivedHistory]) {
    if (thread?.id) {
      threadsById.set(thread.id, thread);
    }
  }

  return project.focusedThreadIds
    .map((threadId) => threadsById.get(threadId))
    .filter(Boolean);
}

function sortThreads(threads) {
  return [...threads].sort((left, right) => {
    if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    }

    return (left.name ?? left.preview ?? left.id).localeCompare(right.name ?? right.preview ?? right.id);
  });
}
