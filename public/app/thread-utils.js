import {
  extractTurnPlanFromItems,
  normalizePlanStep,
  normalizeTurnPlan,
} from './plan-utils.js';
import { findThreadMeta, syncThreadIntoProjects } from './project-utils.js';
import { firstNonEmptyText } from './text-utils.js';

export function normalizeThreadDetail(thread) {
  const pendingQuestions = normalizePendingQuestions(thread?.pendingQuestions);
  const pendingQuestionCount = Number(
    thread?.pendingQuestionCount ?? thread?.pendingQuestions?.length ?? 0,
  );
  const external = normalizeExternalSession(thread?.external);
  return {
    ...thread,
    ...(external ? { external } : {}),
    pendingApprovalCount: Number(
      thread?.pendingApprovalCount ?? thread?.pendingApprovals?.length ?? 0,
    ),
    waitingOnApproval: Boolean(
      thread?.waitingOnApproval ??
        Number(thread?.pendingApprovalCount ?? thread?.pendingApprovals?.length ?? 0) > 0,
    ),
    pendingApprovals: normalizePendingApprovals(thread?.pendingApprovals),
    pendingQuestionCount,
    waitingOnQuestion: Boolean(thread?.waitingOnQuestion ?? pendingQuestionCount > 0),
    pendingQuestions,
    turns: (thread?.turns ?? []).map((turn) => ({
      id: turn.id,
      status: turn.status ?? 'unknown',
      error: turn.error ?? null,
      plan: normalizeTurnPlan(turn.plan) ?? extractTurnPlanFromItems(turn.items ?? []),
      items: (turn.items ?? []).map((item) => normalizeStreamedItem(item, { preserveStreaming: true })),
    })),
  };
}

export function normalizePendingApprovals(approvals) {
  return (approvals ?? []).map((approval) => normalizeApprovalEntry(approval));
}

export function normalizeExternalSession(external) {
  if (!external || typeof external !== 'object') {
    return null;
  }

  const bridgeMode = normalizeExternalBridgeMode(external.bridgeMode);
  const runtimeSource = firstNonEmptyText(external.runtimeSource);
  const transcriptPath = firstNonEmptyText(external.transcriptPath);
  const lastSeenAt = normalizePositiveInteger(external.lastSeenAt);

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

export function normalizeExternalBridgeMode(value) {
  const normalized = firstNonEmptyText(value);
  if (normalized === 'discovered' || normalized === 'hooked' || normalized === 'hooked+tail') {
    return normalized;
  }

  return null;
}

export function normalizePositiveInteger(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function normalizePendingQuestions(questions) {
  return (questions ?? []).map((question) => normalizePendingQuestionEntry(question));
}

export function normalizeApprovalEntry(approval) {
  if (!approval) {
    return approval;
  }

  return {
    ...approval,
    summary: approval.summary ?? '',
    detail:
      approval.detail && typeof approval.detail === 'object' && !Array.isArray(approval.detail)
        ? { ...approval.detail }
        : {},
    status: approval.status ?? 'pending',
  };
}

export function normalizePendingQuestionEntry(question) {
  if (!question) {
    return question;
  }

  return {
    ...question,
    summary: question.summary ?? '',
    prompt: question.prompt ?? question.summary ?? '',
    questions: Array.isArray(question.questions) ? [...question.questions] : [],
    response:
      question.response && typeof question.response === 'object'
        ? { ...question.response }
        : question.response ?? null,
    status: question.status ?? 'pending',
  };
}

export function normalizeThreadStatus(status) {
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

export function collectProjectRuntimeState(projects) {
  const runtimeState = {
    turnStatusBySession: {},
    activeTurnIdBySession: {},
    diffBySession: {},
    realtimeBySession: {},
  };

  for (const project of projects ?? []) {
    for (const thread of [
      ...(project.focusedSessions ?? []),
      ...(project.historySessions?.active ?? []),
      ...(project.historySessions?.archived ?? []),
    ]) {
      collectThreadRuntimeState(runtimeState, thread);
    }
  }

  return runtimeState;
}

export function collectThreadRuntimeState(runtimeState, thread) {
  if (!thread?.id) {
    return runtimeState;
  }

  const normalizedRuntime = normalizeThreadRuntime(thread.runtime);
  runtimeState.turnStatusBySession[thread.id] = normalizedRuntime.turnStatus;

  if (normalizedRuntime.activeTurnId) {
    runtimeState.activeTurnIdBySession[thread.id] = normalizedRuntime.activeTurnId;
  }

  if (normalizedRuntime.diff) {
    runtimeState.diffBySession[thread.id] = normalizedRuntime.diff;
  }

  if (hasRealtimeSessionData(normalizedRuntime.realtime)) {
    runtimeState.realtimeBySession[thread.id] = normalizedRuntime.realtime;
  }

  return runtimeState;
}

export function replaceSessionRuntimeState(state, thread) {
  if (!thread?.id) {
    return state;
  }

  const normalizedRuntime = normalizeThreadRuntime(thread.runtime);
  const nextActiveTurnIdBySession = {
    ...state.activeTurnIdBySession,
  };
  const nextDiffBySession = {
    ...state.diffBySession,
  };
  const nextRealtimeBySession = {
    ...state.realtimeBySession,
  };

  if (normalizedRuntime.activeTurnId) {
    nextActiveTurnIdBySession[thread.id] = normalizedRuntime.activeTurnId;
  } else {
    delete nextActiveTurnIdBySession[thread.id];
  }

  if (normalizedRuntime.diff) {
    nextDiffBySession[thread.id] = normalizedRuntime.diff;
  } else {
    delete nextDiffBySession[thread.id];
  }

  if (hasRealtimeSessionData(normalizedRuntime.realtime)) {
    nextRealtimeBySession[thread.id] = normalizedRuntime.realtime;
  } else {
    delete nextRealtimeBySession[thread.id];
  }

  return {
    ...state,
    turnStatusBySession: {
      ...state.turnStatusBySession,
      [thread.id]: normalizedRuntime.turnStatus,
    },
    activeTurnIdBySession: nextActiveTurnIdBySession,
    diffBySession: nextDiffBySession,
    realtimeBySession: nextRealtimeBySession,
  };
}

export function applyRuntimeSnapshotToState(state, threadId, runtime) {
  const normalizedRuntime = normalizeThreadRuntime(runtime);
  const nextActiveTurnIdBySession = {
    ...state.activeTurnIdBySession,
  };
  const nextDiffBySession = {
    ...state.diffBySession,
  };
  const nextRealtimeBySession = {
    ...state.realtimeBySession,
  };

  if (normalizedRuntime.activeTurnId) {
    nextActiveTurnIdBySession[threadId] = normalizedRuntime.activeTurnId;
  } else {
    delete nextActiveTurnIdBySession[threadId];
  }

  if (normalizedRuntime.diff) {
    nextDiffBySession[threadId] = normalizedRuntime.diff;
  } else {
    delete nextDiffBySession[threadId];
  }

  if (hasRealtimeSessionData(normalizedRuntime.realtime)) {
    nextRealtimeBySession[threadId] = normalizedRuntime.realtime;
  } else {
    delete nextRealtimeBySession[threadId];
  }

  return {
    ...state,
    turnStatusBySession: {
      ...state.turnStatusBySession,
      [threadId]: normalizedRuntime.turnStatus,
    },
    activeTurnIdBySession: nextActiveTurnIdBySession,
    diffBySession: nextDiffBySession,
    realtimeBySession: nextRealtimeBySession,
  };
}

export function normalizeThreadRuntime(runtime) {
  return {
    turnStatus: runtime?.turnStatus ?? 'idle',
    activeTurnId: runtime?.activeTurnId ?? null,
    diff: runtime?.diff ?? null,
    realtime: normalizeRealtimeSessionState(runtime?.realtime),
  };
}

export function createRealtimeSessionState(overrides = {}) {
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

export function normalizeRealtimeSessionState(realtime) {
  if (!realtime) {
    return createRealtimeSessionState();
  }

  return createRealtimeSessionState({
    ...realtime,
    items: (realtime.items ?? []).map((item, index) => ({
      index: item.index ?? index + 1,
      summary: item.summary ?? summarizeRealtimeItem(item.value),
      value: item.value,
    })),
    audioChunkCount: Number(realtime.audioChunkCount ?? 0),
    audioByteCount: Number(realtime.audioByteCount ?? 0),
    lastAudio: realtime.lastAudio
      ? {
          sampleRate: realtime.lastAudio.sampleRate ?? null,
          numChannels: realtime.lastAudio.numChannels ?? null,
          samplesPerChannel: realtime.lastAudio.samplesPerChannel ?? null,
        }
      : null,
  });
}

export function updateSessionRealtime(state, threadId, updater) {
  const currentRealtime = normalizeRealtimeSessionState(state.realtimeBySession[threadId]);
  return {
    ...state,
    realtimeBySession: {
      ...state.realtimeBySession,
      [threadId]: normalizeRealtimeSessionState(updater(currentRealtime)),
    },
  };
}

export function createRealtimeItemEntry(index, value) {
  return {
    index,
    summary: summarizeRealtimeItem(value),
    value,
  };
}

export function summarizeRealtimeItem(value) {
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

export function hasRealtimeSessionData(realtime) {
  return Boolean(
    realtime.sessionId ||
      realtime.items.length ||
      realtime.audioChunkCount > 0 ||
      realtime.lastError ||
      realtime.closeReason ||
      realtime.status !== 'idle',
  );
}

export function formatRealtimeAudioSummary(realtime) {
  const parts = [`${realtime.audioChunkCount} chunks`];
  if (realtime.lastAudio?.sampleRate) {
    parts.push(`${realtime.lastAudio.sampleRate} Hz`);
  }
  if (realtime.lastAudio?.numChannels) {
    parts.push(`${realtime.lastAudio.numChannels} ch`);
  }
  return parts.join(' · ');
}

export function updateSessionThread(state, threadId, updater) {
  const currentThread =
    state.sessionDetailsById[threadId] ??
    createThreadDetailSkeleton(findThreadMeta(state.projects, threadId) ?? { id: threadId });

  if (!currentThread?.id) {
    return state;
  }

  const nextThread = normalizeThreadDetail(updater(currentThread));
  return {
    ...state,
    projects: syncThreadIntoProjects(state.projects, nextThread),
    sessionDetailsById: {
      ...state.sessionDetailsById,
      [threadId]: nextThread,
    },
  };
}

export function createThreadDetailSkeleton(thread) {
  return {
    id: thread.id,
    name: thread.name ?? thread.preview ?? thread.id,
    preview: thread.preview ?? '',
    cwd: thread.cwd ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    status: thread.status ?? { type: 'loaded' },
    turns: thread.turns ?? [],
  };
}

export function upsertThreadTurn(thread, turnId, updater) {
  const turns = [...(thread.turns ?? [])];
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  const baseTurn =
    turnIndex === -1
      ? { id: turnId, status: 'started', error: null, items: [] }
      : { ...turns[turnIndex], items: [...(turns[turnIndex].items ?? [])] };
  const nextTurn = updater(baseTurn);

  if (turnIndex === -1) {
    turns.push(nextTurn);
  } else {
    turns[turnIndex] = nextTurn;
  }

  return {
    ...thread,
    updatedAt: Math.floor(Date.now() / 1000),
    turns,
  };
}

export function upsertTurnItem(items, nextItem, matcher) {
  const nextItems = [...items];
  const itemIndex = nextItems.findIndex((item) => matcher(item));
  if (itemIndex === -1) {
    nextItems.push(nextItem);
    return nextItems;
  }

  nextItems[itemIndex] = {
    ...nextItems[itemIndex],
    ...nextItem,
  };
  return nextItems;
}

export function appendItemDelta(items, payload) {
  const { itemId, itemType = 'agentMessage', delta = '' } = payload;
  const nextItems = [...items];
  const itemIndex = nextItems.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    nextItems.push(createDeltaSeedItem({ itemId, itemType, delta }));
    return nextItems;
  }

  nextItems[itemIndex] = mergeItemDelta(nextItems[itemIndex], payload);
  return nextItems;
}

export function markTurnItemsSettled(items) {
  return items.map((item) => {
    if (item.type !== 'agentMessage') {
      return item;
    }

    return {
      ...item,
      streaming: false,
    };
  });
}

export function normalizeStreamedItem(item, options = {}) {
  if (!item) {
    return item;
  }

  if (item.type === 'agentMessage') {
    return {
      ...item,
      text: item.text ?? '',
      streaming:
        options.preserveStreaming && typeof item.streaming === 'boolean'
          ? item.streaming
          : options.streaming ?? false,
    };
  }

  if (item.type === 'plan') {
    return {
      ...item,
      text: item.text ?? '',
      explanation: firstNonEmptyText(item.explanation) || null,
      steps: (item.steps ?? item.plan ?? [])
        .map((step) => normalizePlanStep(step))
        .filter(Boolean),
    };
  }

  if (item.type === 'reasoning') {
    return {
      ...item,
      summary: [...(item.summary ?? [])],
      content: [...(item.content ?? [])],
    };
  }

  if (item.type === 'commandExecution') {
    return {
      ...item,
      aggregatedOutput: item.aggregatedOutput ?? '',
    };
  }

  if (item.type === 'mcpToolCall') {
    return {
      ...item,
      progressMessages: [...(item.progressMessages ?? [])],
    };
  }

  return {
    ...item,
  };
}

export function createDeltaSeedItem({ itemId, itemType, delta }) {
  if (itemType === 'plan') {
    return normalizeStreamedItem({
      type: 'plan',
      id: itemId,
      text: delta ?? '',
      explanation: null,
      steps: [],
    });
  }

  if (itemType === 'reasoning') {
    return normalizeStreamedItem({ type: 'reasoning', id: itemId, summary: [], content: [] });
  }

  if (itemType === 'commandExecution') {
    return normalizeStreamedItem({
      type: 'commandExecution',
      id: itemId,
      command: '',
      cwd: '',
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: delta ?? '',
      exitCode: null,
      durationMs: null,
    });
  }

  if (itemType === 'mcpToolCall') {
    return normalizeStreamedItem({
      type: 'mcpToolCall',
      id: itemId,
      server: '',
      tool: '',
      status: 'inProgress',
      arguments: {},
      result: null,
      error: null,
      durationMs: null,
      progressMessages: [],
    });
  }

  return normalizeStreamedItem(
    { type: 'agentMessage', id: itemId, text: delta ?? '', phase: 'commentary' },
    { streaming: true },
  );
}

export function mergeItemDelta(item, payload) {
  const { itemType = item.type, deltaKind = null, delta = '', summaryIndex = 0, contentIndex = 0, message = '' } =
    payload;

  if (itemType === 'plan' || item.type === 'plan') {
    const planItem = normalizeStreamedItem(
      item.type === 'plan' ? item : createDeltaSeedItem({ itemId: item.id, itemType: 'plan', delta: '' }),
    );
    return {
      ...planItem,
      type: 'plan',
      text: `${planItem.text ?? ''}${delta}`,
    };
  }

  if (itemType === 'reasoning' || item.type === 'reasoning') {
    const reasoning = normalizeStreamedItem(item.type === 'reasoning' ? item : { type: 'reasoning', id: item.id, summary: [], content: [] });
    if (deltaKind === 'reasoning_summary_part_added') {
      ensureIndexedValue(reasoning.summary, summaryIndex, '');
      return reasoning;
    }

    if (deltaKind === 'reasoning_summary_text') {
      ensureIndexedValue(reasoning.summary, summaryIndex, '');
      reasoning.summary[summaryIndex] = `${reasoning.summary[summaryIndex]}${delta}`;
      return reasoning;
    }

    ensureIndexedValue(reasoning.content, contentIndex, '');
    reasoning.content[contentIndex] = `${reasoning.content[contentIndex]}${delta}`;
    return reasoning;
  }

  if (itemType === 'commandExecution' || item.type === 'commandExecution') {
    return {
      ...normalizeStreamedItem(item.type === 'commandExecution' ? item : createDeltaSeedItem({ itemId: item.id, itemType: 'commandExecution', delta: '' })),
      type: 'commandExecution',
      aggregatedOutput: `${item.aggregatedOutput ?? ''}${delta}`,
      status: item.status ?? 'inProgress',
    };
  }

  if (itemType === 'mcpToolCall' || item.type === 'mcpToolCall') {
    const nextItem = normalizeStreamedItem(item.type === 'mcpToolCall' ? item : createDeltaSeedItem({ itemId: item.id, itemType: 'mcpToolCall', delta: '' }));
    if (deltaKind === 'mcp_progress' && message) {
      nextItem.progressMessages.push(message);
    }
    return nextItem;
  }

  return {
    ...item,
    type: 'agentMessage',
    text: `${item.text ?? ''}${delta}`,
    streaming: true,
  };
}

export function ensureIndexedValue(values, index, seed = '') {
  while (values.length <= index) {
    values.push(seed);
  }
}
