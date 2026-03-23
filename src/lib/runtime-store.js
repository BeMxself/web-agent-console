import { loadJsonSnapshotFile, writeJsonSnapshotFile } from './json-file-store.js';

const SNAPSHOT_VERSION = 4;
const EMPTY_SNAPSHOT = Object.freeze({
  version: SNAPSHOT_VERSION,
  approvalMode: 'auto-approve',
  pendingActions: {},
  threads: {},
  threadSettings: {},
});

export class RuntimeStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.snapshot = null;
  }

  async load() {
    if (this.snapshot) {
      return this.snapshot;
    }

    this.snapshot = await loadJsonSnapshotFile({
      filePath: this.filePath,
      emptySnapshot: EMPTY_SNAPSHOT,
      normalizeSnapshot,
    });
    return this.snapshot;
  }

  async setThreadRuntime(threadId, runtime) {
    const snapshot = await this.load();
    if (!threadId) {
      return null;
    }

    snapshot.threads[threadId] = normalizeThreadRuntime(runtime);
    await this.save(snapshot);
    return snapshot.threads[threadId];
  }

  async deleteThreadRuntime(threadId) {
    const snapshot = await this.load();
    if (!threadId || !snapshot.threads[threadId]) {
      return null;
    }

    delete snapshot.threads[threadId];
    await this.save(snapshot);
    return null;
  }

  async setApprovalMode(mode) {
    const snapshot = await this.load();
    snapshot.approvalMode = normalizeApprovalMode(mode);
    await this.save(snapshot);
    return snapshot.approvalMode;
  }

  async setApproval(approvalId, approval) {
    return await this.setPendingAction(approvalId, approval);
  }

  async setPendingAction(actionId, action) {
    const snapshot = await this.load();
    if (!actionId) {
      return null;
    }

    snapshot.pendingActions[actionId] = normalizePendingActionRecord(action);
    await this.save(snapshot);
    return snapshot.pendingActions[actionId];
  }

  async setThreadSettings(threadId, settings) {
    const snapshot = await this.load();
    if (!threadId) {
      return null;
    }

    snapshot.threadSettings[threadId] = normalizeThreadSettings(settings);
    await this.save(snapshot);
    return snapshot.threadSettings[threadId];
  }

  async deleteThreadSettings(threadId) {
    const snapshot = await this.load();
    if (!threadId || !snapshot.threadSettings[threadId]) {
      return null;
    }

    delete snapshot.threadSettings[threadId];
    await this.save(snapshot);
    return null;
  }

  async deleteApproval(approvalId) {
    return await this.deletePendingAction(approvalId);
  }

  async deletePendingAction(actionId) {
    const snapshot = await this.load();
    if (!actionId || !snapshot.pendingActions[actionId]) {
      return null;
    }

    delete snapshot.pendingActions[actionId];
    await this.save(snapshot);
    return null;
  }

  async save(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    await writeJsonSnapshotFile(this.filePath, normalized);
    this.snapshot = normalized;
    return normalized;
  }
}

function normalizeSnapshot(snapshot) {
  const snapshotVersion = Number(snapshot?.version ?? 0);
  const legacyApprovalMode = snapshotVersion > 0 && snapshotVersion < 3;
  const threads = {};
  const pendingActions = {};
  const threadSettings = {};

  for (const [threadId, runtime] of Object.entries(snapshot?.threads ?? {})) {
    if (!threadId) {
      continue;
    }

    threads[threadId] = normalizeThreadRuntime(runtime);
  }

  for (const [actionId, action] of Object.entries(snapshot?.pendingActions ?? {})) {
    if (!actionId) {
      continue;
    }

    pendingActions[actionId] = normalizePendingActionRecord(action);
  }

  for (const [approvalId, approval] of Object.entries(snapshot?.approvals ?? {})) {
    if (!approvalId || pendingActions[approvalId]) {
      continue;
    }

    pendingActions[approvalId] = normalizePendingActionRecord({
      ...approval,
      id: approval?.id ?? approvalId,
    });
  }

  for (const [threadId, settings] of Object.entries(snapshot?.threadSettings ?? {})) {
    if (!threadId) {
      continue;
    }

    threadSettings[threadId] = normalizeThreadSettings(settings);
  }

  return {
    version: SNAPSHOT_VERSION,
    approvalMode: normalizeApprovalMode(snapshot?.approvalMode, { legacyApprovalMode }),
    pendingActions,
    threads,
    threadSettings,
  };
}

function normalizeThreadRuntime(runtime) {
  const normalized = {
    turnStatus: runtime?.turnStatus ?? 'idle',
    activeTurnId: runtime?.activeTurnId ?? null,
    diff: runtime?.diff ?? null,
    realtime: normalizeRealtimeState(runtime?.realtime),
  };

  normalized.source =
    normalized.turnStatus !== 'idle' ||
    normalized.activeTurnId ||
    normalized.diff ||
    hasRealtimeState(normalized.realtime)
      ? normalizeRuntimeSource(runtime?.source)
      : null;

  return normalized;
}

function normalizeRuntimeSource(source) {
  if (source === 'externalRollout' || source === 'claude-hook') {
    return source;
  }

  return 'appServer';
}

function normalizeThreadSettings(settings) {
  return {
    model: normalizeOptionalSetting(settings?.model),
    reasoningEffort: normalizeReasoningEffort(settings?.reasoningEffort),
  };
}

function normalizeRealtimeState(realtime) {
  return {
    status: realtime?.status ?? 'idle',
    sessionId: realtime?.sessionId ?? null,
    items: (realtime?.items ?? []).map((item, index) => ({
      index: item?.index ?? index + 1,
      summary: item?.summary ?? summarizeRealtimeItem(item?.value),
      value: item?.value ?? null,
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
    lastError: realtime?.lastError ?? null,
    closeReason: realtime?.closeReason ?? null,
  };
}

function summarizeRealtimeItem(value) {
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

function hasRealtimeState(realtime) {
  return Boolean(
    realtime?.sessionId ||
      (realtime?.items ?? []).length ||
      Number(realtime?.audioChunkCount ?? 0) > 0 ||
      realtime?.lastError ||
      realtime?.closeReason ||
      realtime?.status !== 'idle',
  );
}

export function normalizeApprovalMode(mode, { legacyApprovalMode = false } = {}) {
  if (mode === 'manual') {
    return legacyApprovalMode ? 'auto-approve' : 'manual';
  }

  return 'auto-approve';
}

export function normalizePendingActionRecord(action) {
  const kind = normalizePendingActionKind(action?.kind);
  const payload = normalizePendingActionPayload(kind, action);

  return {
    id: action?.id ?? null,
    threadId: action?.threadId ?? null,
    originThreadId: action?.originThreadId ?? action?.threadId ?? null,
    turnId: action?.turnId ?? null,
    itemId: action?.itemId ?? null,
    kind,
    summary: normalizeSummary(action?.summary, payload),
    payload,
    status: normalizePendingActionStatus(action?.status, kind),
    createdAt: Number(action?.createdAt ?? 0),
    resolvedAt:
      action?.resolvedAt == null
        ? null
        : Number(action.resolvedAt),
    resolutionSource: action?.resolutionSource ?? null,
  };
}

export function clonePendingActionRecord(action) {
  return normalizePendingActionRecord(action);
}

export function createApprovalRecordFromPendingAction(action) {
  const normalized = normalizePendingActionRecord(action);
  if (normalized.kind !== 'tool_approval') {
    return null;
  }

  return {
    id: normalized.id,
    threadId: normalized.threadId,
    originThreadId: normalized.originThreadId,
    turnId: normalized.turnId,
    itemId: normalized.itemId,
    kind: normalized.payload.approvalKind ?? 'unknown',
    summary: normalized.summary,
    detail: cloneStructuredValue(normalized.payload.detail ?? {}),
    status: normalized.status,
    createdAt: normalized.createdAt,
    resolvedAt: normalized.resolvedAt,
    resolutionSource: normalized.resolutionSource,
  };
}

export function createPendingQuestionRecordFromPendingAction(action) {
  const normalized = normalizePendingActionRecord(action);
  if (normalized.kind !== 'ask_user_question') {
    return null;
  }

  return {
    id: normalized.id,
    threadId: normalized.threadId,
    originThreadId: normalized.originThreadId,
    turnId: normalized.turnId,
    itemId: normalized.itemId,
    kind: normalized.kind,
    summary: normalized.summary,
    prompt: normalized.payload.prompt ?? normalized.summary,
    questions: cloneStructuredValue(normalized.payload.questions ?? []),
    response: cloneStructuredValue(normalized.payload.response ?? null),
    annotations: cloneStructuredValue(normalized.payload.annotations ?? null),
    status: normalized.status,
    createdAt: normalized.createdAt,
    resolvedAt: normalized.resolvedAt,
    resolutionSource: normalized.resolutionSource,
  };
}

export function listPendingApprovalsFromPendingActions(pendingActionsById, threadId = null) {
  return listPendingActionsByKind(pendingActionsById, {
    kind: 'tool_approval',
    threadId,
  })
    .map((action) => createApprovalRecordFromPendingAction(action))
    .filter(Boolean);
}

export function listPendingQuestionsFromPendingActions(pendingActionsById, threadId = null) {
  return listPendingActionsByKind(pendingActionsById, {
    kind: 'ask_user_question',
    threadId,
  })
    .map((action) => createPendingQuestionRecordFromPendingAction(action))
    .filter(Boolean);
}

function normalizeOptionalSetting(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }

  return null;
}

function listPendingActionsByKind(pendingActionsById, { kind, threadId = null } = {}) {
  return listPendingActions(pendingActionsById)
    .filter((action) => action?.status === 'pending')
    .filter((action) => !kind || action.kind === kind)
    .filter((action) => !threadId || action.threadId === threadId)
    .sort((left, right) => {
      if ((left.createdAt ?? 0) !== (right.createdAt ?? 0)) {
        return (left.createdAt ?? 0) - (right.createdAt ?? 0);
      }

      return String(left.id).localeCompare(String(right.id));
    });
}

function listPendingActions(pendingActionsById) {
  if (pendingActionsById instanceof Map) {
    return [...pendingActionsById.values()].map((action) => normalizePendingActionRecord(action));
  }

  return Object.values(pendingActionsById ?? {}).map((action) => normalizePendingActionRecord(action));
}

function normalizePendingActionKind(kind) {
  if (kind === 'ask_user_question') {
    return 'ask_user_question';
  }

  return 'tool_approval';
}

function normalizePendingActionStatus(status, kind) {
  if (
    status === 'approved' ||
    status === 'denied' ||
    status === 'answered' ||
    status === 'auto-approved'
  ) {
    return status;
  }

  return kind === 'ask_user_question' && status === 'resolved' ? 'answered' : 'pending';
}

function normalizePendingActionPayload(kind, action) {
  const payload = isPlainObject(action?.payload) ? action.payload : {};

  if (kind === 'ask_user_question') {
    return {
      prompt: normalizeOptionalSetting(payload.prompt ?? action?.prompt ?? action?.summary) ?? '',
      questions: normalizeQuestions(payload.questions ?? action?.questions),
      response: cloneStructuredValue(payload.response ?? action?.response ?? null),
      annotations: cloneStructuredValue(payload.annotations ?? action?.annotations ?? null),
      toolUseId: normalizeOptionalSetting(payload.toolUseId ?? action?.toolUseId),
    };
  }

  const approvalKind = normalizeApprovalKind(payload.approvalKind ?? action?.approvalKind ?? action?.kind);
  return {
    approvalKind,
    detail: cloneStructuredValue(payload.detail ?? action?.detail ?? {}),
    toolUseId: normalizeOptionalSetting(payload.toolUseId ?? action?.toolUseId),
  };
}

function normalizeApprovalKind(kind) {
  const normalized = normalizeOptionalSetting(kind);
  if (!normalized || normalized === 'tool_approval' || normalized === 'ask_user_question') {
    return 'unknown';
  }

  return normalized;
}

function normalizeSummary(summary, payload) {
  const normalizedSummary = normalizeOptionalSetting(summary);
  if (normalizedSummary) {
    return normalizedSummary;
  }

  return normalizeOptionalSetting(payload?.prompt) ?? '';
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions
    .filter((question) => isPlainObject(question))
    .map((question) => ({
      header: normalizeOptionalSetting(question.header) ?? '',
      question: normalizeOptionalSetting(question.question) ?? '',
      multiSelect: Boolean(question.multiSelect),
      options: Array.isArray(question.options)
        ? question.options
            .filter((option) => isPlainObject(option))
            .map((option) => ({
              label: normalizeOptionalSetting(option.label) ?? '',
              description: normalizeOptionalSetting(option.description) ?? '',
              preview: normalizeOptionalSetting(option.preview),
            }))
        : [],
    }));
}

function cloneStructuredValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneStructuredValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneStructuredValue(entry)]),
    );
  }

  return value ?? null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
