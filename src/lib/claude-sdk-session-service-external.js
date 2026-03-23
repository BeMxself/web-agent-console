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

export async function ingestExternalBridgeEvent(service, payload) {
  await service.ensureRuntimeStoreLoaded();
  const ingress = service.externalSessionBridge.ingest(payload);
  if (!ingress.accepted || ingress.ignored) {
    return ingress;
  }

  return await service.handleExternalHookEvent(ingress.provider, ingress.event);
}

export async function handleExternalHookEvent(service, provider, event) {
  switch (event.hookEventName) {
    case 'SessionStart':
      return await service.handleExternalSessionStart(provider, event);
    case 'PreToolUse':
    case 'PermissionRequest':
      return await service.handleExternalPermissionRequest(provider, event);
    case 'PostToolUse':
      return await service.handleExternalPostToolUse(provider, event);
    case 'Elicitation':
      return await service.handleExternalElicitation(provider, event);
    case 'ElicitationResult':
      return await service.handleExternalElicitationResult(provider, event);
    case 'Stop':
      return await service.handleExternalStop(provider, event);
    case 'StopFailure':
      return await service.handleExternalStopFailure(provider, event);
    default:
      return buildIgnoredResult(provider, 'unsupported_hook_event');
  }
}

export async function handleExternalSessionStart(service, provider, event) {
  const prepared = await service.prepareExternalHookThread(event);
  if (!prepared) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  return await service.buildAcceptedExternalThreadResult(provider, prepared.threadRecord);
}

export async function handleExternalPermissionRequest(service, provider, event) {
  const prepared = await service.prepareExternalHookThread(event);
  if (!prepared) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  const { threadRecord, runtime } = prepared;
  const { result } = await service.requestPendingAction({
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

  return await service.buildAcceptedExternalThreadResult(provider, threadRecord, result);
}

export async function handleExternalPostToolUse(service, provider, event) {
  const threadRecord = await service.ensureExternalBridgeThread(event);
  if (!threadRecord) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  await service.resolveExternalPendingActions(threadRecord.threadId, {
    kind: 'tool_approval',
    toolUseId: event.toolUseId,
    status: 'approved',
    resolutionSource: 'external',
  });

  return await service.buildAcceptedExternalThreadResult(provider, threadRecord);
}

export async function handleExternalElicitation(service, provider, event) {
  const prepared = await service.prepareExternalHookThread(event);
  if (!prepared) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  const { threadRecord, runtime } = prepared;
  const { result } = await service.requestPendingAction({
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

  return await service.buildAcceptedExternalThreadResult(provider, threadRecord, result);
}

export async function handleExternalElicitationResult(service, provider, event) {
  const threadRecord = await service.ensureExternalBridgeThread(event);
  if (!threadRecord) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  await service.resolveExternalPendingActions(threadRecord.threadId, {
    kind: 'ask_user_question',
    toolUseId: event.toolUseId,
    status: 'answered',
    resolutionSource: 'external',
    response: event.response,
  });

  return await service.buildAcceptedExternalThreadResult(provider, threadRecord);
}

export async function handleExternalStop(service, provider, event) {
  const threadRecord = await service.ensureExternalBridgeThread(event);
  if (!threadRecord) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  await service.resolveOpenExternalPendingActions(threadRecord.threadId, {
    toolApprovalStatus: 'approved',
    questionStatus: 'answered',
    resolutionSource: 'external',
  });

  const turnId =
    service.runtimeByThread.get(threadRecord.threadId)?.activeTurnId ?? createExternalTurnId(event.sessionId);
  await service.reconcileRuntimeSnapshot(
    threadRecord.threadId,
    createCompletedHookRuntime(service.runtimeByThread.get(threadRecord.threadId)),
    {
      threadStatus: {
        type: 'idle',
      },
      completedTurnId: turnId,
    },
  );
  await service.stopExternalTranscriptWatcher(threadRecord.threadId);

  return await service.buildAcceptedExternalThreadResult(provider, threadRecord);
}

export async function handleExternalStopFailure(service, provider, event) {
  const threadRecord = await service.ensureExternalBridgeThread(event);
  if (!threadRecord) {
    return buildIgnoredResult(provider, 'unknown_project');
  }

  await service.resolveOpenExternalPendingActions(threadRecord.threadId, {
    toolApprovalStatus: 'denied',
    questionStatus: 'answered',
    resolutionSource: 'external',
    response: event.error,
  });

  await service.reconcileRuntimeSnapshot(
    threadRecord.threadId,
    createErroredHookRuntime(
      service.runtimeByThread.get(threadRecord.threadId),
      event.error ?? 'Claude external session failed',
    ),
    {
      threadStatus: {
        type: 'error',
      },
    },
  );
  await service.stopExternalTranscriptWatcher(threadRecord.threadId);

  return await service.buildAcceptedExternalThreadResult(provider, threadRecord);
}

export async function prepareExternalHookThread(service, event) {
  let threadRecord = await service.ensureExternalBridgeThread(event);
  if (!threadRecord) {
    return null;
  }

  const runtime = createStartedHookRuntime(service.runtimeByThread.get(threadRecord.threadId), {
    sessionId: event.sessionId,
    turnId: createExternalTurnId(event.sessionId),
  });
  await service.reconcileRuntimeSnapshot(threadRecord.threadId, runtime, {
    threadStatus: {
      type: 'active',
      activeFlags: ['running'],
    },
  });

  threadRecord =
    (await service.syncExternalTranscriptWatcher({
      threadRecord,
      transcriptPath: event.transcriptPath,
      turnId: runtime.activeTurnId,
    })) ?? threadRecord;

  return {
    threadRecord,
    runtime,
  };
}

export async function buildAcceptedExternalThreadResult(service, provider, threadRecord, resolution = undefined) {
  return {
    accepted: true,
    provider,
    thread: service.decorateThread(createClaudeThreadPlaceholder(threadRecord), threadRecord),
    ...(resolution == null ? {} : { resolution }),
  };
}

export async function resolveExternalPendingActions(service, 
  threadId,
  {
    kind = null,
    toolUseId = null,
    status,
    resolutionSource = 'external',
    response = null,
  },
) {
  const matches = [...service.pendingActionsById.values()]
    .map((action) => normalizePendingActionRecord(action))
    .filter((action) => action.threadId === threadId)
    .filter((action) => action.status === 'pending')
    .filter((action) => !kind || action.kind === kind)
    .filter((action) => !toolUseId || action.payload?.toolUseId === toolUseId);

  for (const action of matches) {
    await service.finalizeExternalPendingAction(action, {
      status,
      resolutionSource,
      response,
    });
  }
}

export async function resolveOpenExternalPendingActions(service, 
  threadId,
  {
    toolApprovalStatus = 'approved',
    questionStatus = 'answered',
    resolutionSource = 'external',
    response = null,
  } = {},
) {
  const pendingActions = [...service.pendingActionsById.values()]
    .map((action) => normalizePendingActionRecord(action))
    .filter((action) => action.threadId === threadId)
    .filter((action) => action.status === 'pending');

  for (const action of pendingActions) {
    const status = action.kind === 'ask_user_question' ? questionStatus : toolApprovalStatus;
    if (!status) {
      continue;
    }

    await service.finalizeExternalPendingAction(action, {
      status,
      resolutionSource,
      response,
    });
  }
}

export async function finalizeExternalPendingAction(service, 
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
  const resolutionPayload = service.getPendingActionResolutionPayload(pendingAction, resolution);
  const result = service.getPendingActionResolutionResult(pendingAction, resolution, status);
  return await service.finalizePendingAction(pendingAction.id, {
    status,
    resolutionSource,
    result,
    resolutionPayload,
  });
}

export async function ensureExternalBridgeThread(service, {
  sessionId,
  cwd,
  transcriptPath = null,
}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const knownProjectId = normalizeString(cwd);
  const existingThread = await service.findThreadByClaudeSessionId(normalizedSessionId);
  const projectId = existingThread?.projectId ?? knownProjectId;
  if (!projectId) {
    return null;
  }

  const activity = await service.activityStore.load();
  if (!existingThread && !activity.projects?.[projectId]) {
    return null;
  }

  if (activity.projects?.[projectId]?.hidden) {
    await service.activityStore.addProject?.(projectId);
  }

  const timestamp = nowInSeconds();
  return await service.sessionIndex.upsertThread({
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
