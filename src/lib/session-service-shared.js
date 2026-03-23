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
  const normalized = {
    model: normalizeSessionModel(settings?.model),
    reasoningEffort: normalizeSessionReasoningEffort(settings?.reasoningEffort),
  };

  const sandboxMode = normalizeRuntimeSandboxMode(settings?.sandboxMode);
  if (sandboxMode) {
    normalized.sandboxMode = sandboxMode;
  }

  return normalized;
}

export function cloneSessionSettings(settings) {
  const normalized = normalizeSessionSettings(settings);
  return {
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    ...(normalized.sandboxMode ? { sandboxMode: normalized.sandboxMode } : {}),
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

  if (Array.isArray(options?.sandboxModeOptions)) {
    cloned.sandboxModeOptions = options.sandboxModeOptions.map((option) => ({
      value: option?.value ?? '',
      label: option?.label ?? '',
    }));
  }

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

export function normalizeProviderId(providerId) {
  if (typeof providerId !== 'string') {
    return null;
  }

  const normalized = providerId.trim();
  return normalized || null;
}

export function normalizeAttachmentCapabilities(capabilities) {
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

export function normalizeRuntimeContext(runtimeContext) {
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

export function normalizeRuntimeSandboxMode(sandboxMode) {
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

export function normalizeNonNegativeInteger(value, fallback) {
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

export function normalizeRuntimeSource(source) {
  if (source === 'externalRollout' || source === 'claude-hook') {
    return source;
  }

  return 'appServer';
}

export function hasRuntimeRealtimeState(realtime) {
  return Boolean(
    realtime.sessionId ||
      realtime.items.length ||
      realtime.audioChunkCount > 0 ||
      realtime.lastError ||
      realtime.closeReason ||
      realtime.status !== 'idle',
  );
}

export function summarizeRuntimeRealtimeItem(value) {
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

export function normalizeSessionModel(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeSessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }

  return null;
}

export function shouldPersistSessionSettings(settings) {
  const normalized = normalizeSessionSettings(settings);
  return Boolean(normalized.model || normalized.reasoningEffort || normalized.sandboxMode);
}

export function normalizeApprovalRecord(approval) {
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

export function createQuestionResponse(pendingAction, resolution) {
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

export function normalizeQuestionAnswers(questions, resolution) {
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

export function normalizeApprovalKind(toolName) {
  const normalized = String(toolName ?? '').trim();
  return normalized || 'unknown';
}

export function normalizeToolApprovalDecision(resolution) {
  if (resolution?.status === 'denied' || resolution?.decision === 'denied' || resolution?.allow === false) {
    return false;
  }

  return true;
}

export function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
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


export {
  createInMemoryActivityStore,
  ensureActivityProject,
  buildProjects,
  ensureProject,
  buildFocusedSessions,
  sortThreads,
} from './session-service-projects.js';
