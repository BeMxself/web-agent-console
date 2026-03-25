import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  forkSession,
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
  forkSession,
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


export function createThreadStub(threadId, projectId) {
  return {
    id: threadId,
    name: null,
    preview: '',
    cwd: projectId,
    updatedAt: 0,
    turns: [],
  };
}

export function createImportedClaudeThreadId(sessionId) {
  return `claude-thread-${sessionId}`;
}

export function buildKnownThreadsBySessionId(knownThreads) {
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

export function choosePreferredSessionThread(left, right) {
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

export function isImportedClaudeThread(thread) {
  const sessionId = normalizeString(thread?.claudeSessionId);
  if (!sessionId) {
    return false;
  }

  return thread?.threadId === createImportedClaudeThreadId(sessionId);
}

export function isPrunableDiscoveredThread(thread) {
  return isImportedClaudeThread(thread) && normalizeBridgeMode(thread?.bridgeMode) === 'discovered';
}

export function buildSessionLookupOptions(threadRecord) {
  return threadRecord?.projectId ? { dir: threadRecord.projectId } : {};
}

export function buildQueryOptions({
  abortController,
  canUseTool,
  cwd,
  settings,
  sessionId,
  forkSession = false,
  resumeSessionAt = null,
}) {
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

  if (forkSession) {
    options.forkSession = true;
  }

  if (resumeSessionAt) {
    options.resumeSessionAt = resumeSessionAt;
  }

  if (settings?.model) {
    options.model = settings.model;
  }

  if (settings?.reasoningEffort) {
    options.effort = settings.reasoningEffort;
  }

  if (settings?.agentType) {
    options.agent = settings.agentType;
  }

  return options;
}

export function getQuerySessionId(message) {
  return (
    normalizeString(message?.session_id) ??
    normalizeString(message?.sessionId) ??
    normalizeString(message?.result?.session_id) ??
    normalizeString(message?.result?.sessionId)
  );
}

export function extractAskUserQuestionToolUse(message) {
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

export async function submitAskUserQuestionResponse(queryHandle, { sessionId, toolUseId, toolResult }) {
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

export function createSingleMessageStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
}

export function summarizeClaudeToolApproval(toolName, input, toolOptions) {
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

export async function closeClaudeQuery(queryHandle, iterator) {
  if (typeof queryHandle?.close === 'function') {
    await queryHandle.close();
    return;
  }

  if (typeof iterator?.return === 'function') {
    await iterator.return();
  }
}

export function buildIgnoredResult(provider, reason) {
  return {
    accepted: false,
    provider,
    ignored: true,
    reason,
  };
}

export function createStartedHookRuntime(runtime, { sessionId, turnId }) {
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

export function createCompletedHookRuntime(runtime) {
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

export function createErroredHookRuntime(runtime, reason) {
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

export function attachExternalSessionSnapshot(thread, source) {
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

export function normalizeExternalSessionSnapshot(source) {
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

export function normalizeBridgeMode(value) {
  const normalized = normalizeString(value);
  if (normalized === 'discovered' || normalized === 'hooked' || normalized === 'hooked+tail') {
    return normalized;
  }

  return null;
}

export function getExternalRuntimeSource(bridgeMode) {
  if (bridgeMode === 'discovered') {
    return 'claude-discovered';
  }

  if (bridgeMode === 'hooked' || bridgeMode === 'hooked+tail') {
    return 'claude-external-bridge';
  }

  return null;
}

export function createDeferred() {
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

export function normalizeToolApprovalDecision(resolution) {
  if (resolution?.status === 'denied' || resolution?.decision === 'denied' || resolution?.allow === false) {
    return false;
  }

  return true;
}

export function normalizeDeniedMessage(resolution) {
  const normalized = String(resolution?.message ?? '').trim();
  return normalized || 'User denied tool approval';
}

export function isAbortError(error, abortController) {
  return abortController?.signal?.aborted || error?.name === 'AbortError';
}

export function isActiveExternalHookRuntime(runtime) {
  const normalized = normalizeRuntimeSnapshot(runtime);
  return normalized.source === 'claude-hook' && isRuntimeSnapshotActive(normalized);
}

export function normalizeSessionModel(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'sonnet' || normalized === 'opus' || normalized === 'haiku') {
    return normalized;
  }

  return null;
}

export function normalizeSessionReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }

  return null;
}

export function normalizeClaudeSessionSettings(settings) {
  return {
    model: normalizeSessionModel(settings?.model),
    reasoningEffort: normalizeSessionReasoningEffort(settings?.reasoningEffort),
    agentType: normalizeClaudeSessionAgentType(settings?.agentType),
  };
}

export function shouldPersistClaudeSessionSettings(settings) {
  const normalized = normalizeClaudeSessionSettings(settings);
  return Boolean(normalized.model || normalized.reasoningEffort || normalized.agentType);
}

export function normalizeClaudeSessionAgentType(value) {
  return normalizeString(value);
}

export function normalizeClaudeAgentTypeOptions(agentInfos) {
  const options = [];
  const seenValues = new Set();

  for (const agentInfo of agentInfos ?? []) {
    const value = normalizeClaudeSessionAgentType(agentInfo?.name);
    if (!value || seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    options.push({
      value,
      label: value,
    });
  }

  return options;
}

export function normalizeString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeTimestampMs(value) {
  const numericValue = Number(value ?? 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  return numericValue > 1_000_000_000_000 ? Math.floor(numericValue) : Math.floor(numericValue * 1000);
}

export function normalizeTimestampSeconds(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric > 9_999_999_999) {
    return Math.floor(numeric / 1000);
  }

  return Math.floor(numeric);
}

export function compareProjects(left, right) {
  if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  }

  return left.displayName.localeCompare(right.displayName);
}
