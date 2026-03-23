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

export async function loadProjectThreadMap(service, projectId, threadIds) {
  const threadsById = new Map();

  for (const threadId of threadIds) {
    const threadRecord = await service.sessionIndex.readThread(threadId);
    if (!threadRecord) {
      continue;
    }

    threadsById.set(
      threadId,
      service.decorateThread(createClaudeThreadPlaceholder(threadRecord), threadRecord),
    );
  }

  for (const thread of await service.sessionIndex.listThreadsByProject(projectId)) {
    if (!threadsById.has(thread.threadId)) {
      threadsById.set(
        thread.threadId,
        service.decorateThread(createClaudeThreadPlaceholder(thread), thread),
      );
    }
  }

  return threadsById;
}

export async function syncDiscoveredSessionsForProject(service, projectId) {
  if (typeof service.claudeSdk.listSessions !== 'function') {
    return;
  }

  let knownThreads = await service.sessionIndex.listThreadsByProject(projectId);
  if (await service.reconcileDuplicateSessionThreads(projectId)) {
    knownThreads = await service.sessionIndex.listThreadsByProject(projectId);
  }
  const discoveredSessions = await service.claudeSdk.listSessions({
    dir: projectId,
  });
  if (await service.pruneStaleDiscoveredThreads(projectId, knownThreads, discoveredSessions)) {
    knownThreads = await service.sessionIndex.listThreadsByProject(projectId);
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

    await service.sessionIndex.upsertThread({
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

export async function loadTranscriptThread(service, threadRecord) {
  const options = buildSessionLookupOptions(threadRecord);
  const [sessionInfo, messages] = await Promise.all([
    service.claudeSdk.getSessionInfo(threadRecord.claudeSessionId, options),
    service.claudeSdk.getSessionMessages(threadRecord.claudeSessionId, options),
  ]);
  const nextThreadRecord = await service.sessionIndex.upsertThread({
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

export async function tryReconcileCompletedTranscript(service, threadId) {
  const threadRecord = await service.sessionIndex.readThread(threadId);
  if (!threadRecord?.claudeSessionId) {
    return null;
  }

  try {
    const transcript = await service.loadTranscriptThread(threadRecord);
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

export async function runTurn(service, {
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
      cwd: threadRecord.projectId ?? service.cwd,
      settings: {
        model: turnRequest.model,
        reasoningEffort: turnRequest.reasoningEffort,
      },
      sessionId: threadRecord.claudeSessionId,
      canUseTool: async (toolName, input, toolOptions = {}) => {
        const { result } = await service.requestToolApproval({
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
    queryHandle = service.claudeSdk.query({
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
        threadRecord = await service.sessionIndex.upsertThread({
          ...threadRecord,
          claudeSessionId: resolvedSessionId,
          updatedAt: nowInSeconds(),
        });
        await service.reconcileDuplicateSessionThreads(
          threadRecord.projectId ?? service.cwd,
          resolvedSessionId,
        );
        threadRecord = await service.sessionIndex.readThread(threadId) ?? threadRecord;
        service.setRuntime(threadId, updateRuntimeSessionId(service.runtimeByThread.get(threadId), resolvedSessionId));
        await service.persistRuntimeSnapshot(threadId);
        startDeferred.resolve();
      }

      if (message.type === 'result') {
        resultMessage = message;
      }

      const askQuestion = extractAskUserQuestionToolUse(message);
      if (askQuestion) {
        const { result } = await service.requestUserQuestion({
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
          service.setRuntime(threadId, createCompletedRuntimeSnapshot(service.runtimeByThread.get(threadId)));
          await service.persistRuntimeSnapshot(threadId);
          service.publishThreadStatusChanged(threadId, { type: 'idle' });
        }

        service.publishEvent(event);
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
        service.runtimeByThread.get(threadId),
        'Claude turn interrupted',
      );
      service.setRuntime(threadId, interruptedRuntime);
      await service.persistRuntimeSnapshot(threadId);
      service.publishThreadStatusChanged(threadId, { type: 'idle' });
      service.publishRuntimeReconciled(threadId, interruptedRuntime);
      return;
    }

    const failedRuntime = createErroredRuntimeSnapshot(
      service.runtimeByThread.get(threadId),
      error?.message ?? 'Claude turn failed',
    );
    service.setRuntime(threadId, failedRuntime);
    await service.persistRuntimeSnapshot(threadId);
    service.publishThreadStatusChanged(threadId, { type: 'error' });
    service.publishRuntimeReconciled(threadId, failedRuntime);
    return;
  } finally {
    await closeClaudeQuery(queryHandle, iterator);
  }
}

export function decorateThread(service, thread, threadRecord = null) {
  return service.decorateThreadWithSharedState(
    attachExternalSessionSnapshot(thread, threadRecord ?? thread),
    {
      includePendingApprovals: true,
      includePendingQuestions: true,
    },
  );
}

export async function reconcileDuplicateSessionThreads(service, projectId, sessionId = null) {
  const knownThreads = await service.sessionIndex.listThreadsByProject(projectId);
  const activity = await service.activityStore.load();
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
        await service.activityStore.removeFocusedSession?.(projectId, duplicate.threadId);
        focusedThreadIds.delete(duplicate.threadId);
        if (keeper?.threadId && !focusedThreadIds.has(keeper.threadId)) {
          await service.activityStore.addFocusedSession?.(projectId, keeper.threadId);
          focusedThreadIds.add(keeper.threadId);
        }
      }
      await service.migrateThreadState(duplicate.threadId, keeper?.threadId ?? null);
      await service.sessionIndex.deleteThread?.(duplicate.threadId);
      changed = true;
    }
  }

  return changed;
}

export async function pruneStaleDiscoveredThreads(service, projectId, knownThreads, discoveredSessions) {
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

    await service.activityStore.removeFocusedSession?.(projectId, thread.threadId);
    await service.migrateThreadState(thread.threadId, null);
    await service.sessionIndex.deleteThread?.(thread.threadId);
    changed = true;
  }

  return changed;
}

export async function migrateThreadState(service, sourceThreadId, targetThreadId = null) {
  if (!sourceThreadId || sourceThreadId === targetThreadId) {
    return;
  }

  const sourceRuntime = service.runtimeByThread.get(sourceThreadId);
  const targetRuntime = targetThreadId ? service.runtimeByThread.get(targetThreadId) : null;
  if (sourceRuntime) {
    if (targetThreadId && (!targetRuntime || !hasRuntimeSnapshot(targetRuntime))) {
      service.setRuntime(targetThreadId, sourceRuntime);
      await service.persistRuntimeSnapshot(targetThreadId);
    }
    service.runtimeByThread.delete(sourceThreadId);
    await service.runtimeStore.deleteThreadRuntime?.(sourceThreadId);
  }

  const activeTurn = service.activeTurnsByThread.get(sourceThreadId);
  if (activeTurn && targetThreadId && !service.activeTurnsByThread.has(targetThreadId)) {
    service.activeTurnsByThread.set(targetThreadId, activeTurn);
  }
  service.activeTurnsByThread.delete(sourceThreadId);

  const sourceSettings = service.sessionSettingsByThread.get(sourceThreadId);
  const targetSettings = targetThreadId
    ? service.sessionSettingsByThread.get(targetThreadId)
    : null;
  if (sourceSettings) {
    if (targetThreadId && !shouldPersistClaudeSessionSettings(targetSettings)) {
      service.sessionSettingsByThread.set(targetThreadId, cloneSessionSettings(sourceSettings));
      await service.runtimeStore.setThreadSettings?.(targetThreadId, sourceSettings);
    }
    service.sessionSettingsByThread.delete(sourceThreadId);
    await service.runtimeStore.deleteThreadSettings?.(sourceThreadId);
  }

  for (const [actionId, action] of [...service.pendingActionsById.entries()]) {
    const normalized = normalizePendingActionRecord(action);
    const touchesSource =
      normalized.threadId === sourceThreadId || normalized.originThreadId === sourceThreadId;
    if (!touchesSource) {
      continue;
    }

    if (!targetThreadId) {
      service.pendingActionsById.delete(actionId);
      await service.runtimeStore.deletePendingAction?.(actionId);
      continue;
    }

    await service.upsertPendingAction({
      ...normalized,
      threadId: normalized.threadId === sourceThreadId ? targetThreadId : normalized.threadId,
      originThreadId:
        normalized.originThreadId === sourceThreadId
          ? targetThreadId
          : normalized.originThreadId,
    });
  }
}

export async function findThreadByClaudeSessionId(service, sessionId) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const idsByProject = await service.sessionIndex.listThreadIdsByProject();
  for (const projectId of idsByProject.keys()) {
    const thread = buildKnownThreadsBySessionId(
      await service.sessionIndex.listThreadsByProject(projectId),
    ).get(normalizedSessionId);
    if (thread) {
      return thread;
    }
  }

  return null;
}


export async function syncExternalTranscriptWatcher(service, {
  threadRecord,
  transcriptPath = null,
  turnId = null,
} = {}) {
  const normalizedPath = normalizeString(transcriptPath);
  if (!threadRecord?.threadId || !normalizedPath || !turnId) {
    return threadRecord;
  }

  const existingWatcher = service.externalTranscriptWatchersByThread.get(threadRecord.threadId) ?? null;
  if (
    existingWatcher?.transcriptPath === normalizedPath &&
    existingWatcher?.turnId === turnId
  ) {
    return await service.sessionIndex.readThread(threadRecord.threadId) ?? threadRecord;
  }

  if (existingWatcher) {
    existingWatcher.watcher.stop();
    service.externalTranscriptWatchersByThread.delete(threadRecord.threadId);
  }

  const watcher = new ClaudeExternalTranscriptWatcher({
    threadId: threadRecord.threadId,
    turnId,
    projectId: threadRecord.projectId,
    transcriptPath: normalizedPath,
    pollIntervalMs: service.externalTranscriptPollMs,
    onEvents: (events) => {
      for (const event of events) {
        service.publishEvent(event);
      }
    },
    onError: async () => {
      const tracked = service.externalTranscriptWatchersByThread.get(threadRecord.threadId);
      if (tracked?.watcher !== watcher) {
        return;
      }
      service.externalTranscriptWatchersByThread.delete(threadRecord.threadId);
      const latestThread = await service.sessionIndex.readThread(threadRecord.threadId);
      if (!latestThread) {
        return;
      }
      await service.sessionIndex.upsertThread({
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

  service.externalTranscriptWatchersByThread.set(threadRecord.threadId, {
    watcher,
    transcriptPath: normalizedPath,
    turnId,
  });

  return await service.sessionIndex.upsertThread({
    ...threadRecord,
    bridgeMode: 'hooked+tail',
    transcriptPath: normalizedPath,
  });
}

export async function stopExternalTranscriptWatcher(service, threadId) {
  const existingWatcher = service.externalTranscriptWatchersByThread.get(threadId) ?? null;
  if (!existingWatcher) {
    return;
  }

  existingWatcher.watcher.stop();
  service.externalTranscriptWatchersByThread.delete(threadId);

  const threadRecord = await service.sessionIndex.readThread(threadId);
  if (!threadRecord || threadRecord.bridgeMode !== 'hooked+tail') {
    return;
  }

  await service.sessionIndex.upsertThread({
    ...threadRecord,
    bridgeMode: 'hooked',
  });
}

