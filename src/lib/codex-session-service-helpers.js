import { basename } from 'node:path';
import {
  CODEX_ATTACHMENT_CAPABILITIES,
  mapCodexAttachmentsToInput,
  validateCodexAttachments,
} from './codex-attachments.js';
import { mapCodexNotification } from './codex-event-mapper.js';
import { readRolloutThreadSnapshot, readThreadFromRolloutFile } from './rollout-thread-reader.js';
import {
  SessionService,
  DEFAULT_SESSION_OPTIONS,
  applyThreadStatusOverride,
  attachPendingActionSnapshot,
  attachRuntimeSnapshot,
  attachSessionSettings,
  buildProjects,
  cloneApprovalRecord,
  clonePendingQuestionRecord,
  createApprovalResolution,
  hasRuntimeSnapshot,
  hasThreadActiveFlag,
  isRuntimeSnapshotActive,
  normalizeRuntimeSnapshot,
  nowInSeconds,
  sanitizeThreadStatus,
} from './session-service.js';
import { normalizeTurnRequestInput } from './turn-request.js';
import {
  createApprovalRecordFromPendingAction,
  normalizePendingActionRecord,
} from './runtime-store.js';


export function sanitizeThreads(threads) {
  return threads.map((thread) => sanitizeThread(thread));
}

export function sanitizeThread(thread) {
  if (!thread || typeof thread !== 'object') {
    return thread;
  }

  const { worktree: _worktree, ...rest } = thread;
  return {
    ...rest,
    turns: Array.isArray(rest.turns) ? rest.turns.map((turn) => sanitizeTurn(turn)) : rest.turns,
  };
}

export function sanitizeTurn(turn) {
  if (!turn || typeof turn !== 'object') {
    return turn;
  }

  const { worktree: _worktree, ...rest } = turn;
  return {
    ...rest,
    items: Array.isArray(rest.items) ? rest.items.map((item) => sanitizeTurnItem(item)) : rest.items,
  };
}

export function sanitizeTurnItem(item) {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const { worktree: _worktree, ...rest } = item;
  return {
    ...rest,
  };
}

export function applyRuntimeEvent(runtime, event) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);

  switch (event?.type) {
    case 'turn_started':
      nextRuntime.source = 'appServer';
      nextRuntime.turnStatus = 'started';
      nextRuntime.activeTurnId = event.payload?.turnId ?? null;
      return nextRuntime;
    case 'turn_completed':
      nextRuntime.source = 'appServer';
      nextRuntime.turnStatus = 'completed';
      nextRuntime.activeTurnId = null;
      return nextRuntime;
    case 'turn_diff_updated':
      nextRuntime.source = 'appServer';
      nextRuntime.diff = event.payload?.diff ?? null;
      return nextRuntime;
    case 'thread_realtime_started':
      nextRuntime.source = 'appServer';
      nextRuntime.realtime = {
        ...nextRuntime.realtime,
        status: 'started',
        sessionId: event.payload?.sessionId ?? null,
      };
      return nextRuntime;
    case 'thread_realtime_item_added':
      nextRuntime.source = 'appServer';
      nextRuntime.realtime = {
        ...nextRuntime.realtime,
        status:
          nextRuntime.realtime.status === 'idle'
            ? 'started'
            : nextRuntime.realtime.status,
        items: [
          ...nextRuntime.realtime.items,
          {
            index: nextRuntime.realtime.items.length + 1,
            summary: summarizeRuntimeItem(event.payload?.item),
            value: event.payload?.item,
          },
        ],
      };
      return nextRuntime;
    case 'thread_realtime_audio_delta': {
      nextRuntime.source = 'appServer';
      const audio = event.payload?.audio ?? {};
      const data = String(audio.data ?? '');
      nextRuntime.realtime = {
        ...nextRuntime.realtime,
        status:
          nextRuntime.realtime.status === 'idle'
            ? 'started'
            : nextRuntime.realtime.status,
        audioChunkCount: nextRuntime.realtime.audioChunkCount + 1,
        audioByteCount: nextRuntime.realtime.audioByteCount + data.length,
        lastAudio: {
          sampleRate: audio.sampleRate ?? null,
          numChannels: audio.numChannels ?? null,
          samplesPerChannel: audio.samplesPerChannel ?? null,
        },
      };
      return nextRuntime;
    }
    case 'thread_realtime_error':
      nextRuntime.source = 'appServer';
      nextRuntime.realtime = {
        ...nextRuntime.realtime,
        status: 'error',
        lastError: event.payload?.message ?? null,
      };
      return nextRuntime;
    case 'thread_realtime_closed':
      nextRuntime.source = 'appServer';
      nextRuntime.realtime = {
        ...nextRuntime.realtime,
        status: 'closed',
        closeReason: event.payload?.reason ?? null,
      };
      return nextRuntime;
    default:
      return nextRuntime;
  }
}

export function summarizeRuntimeItem(value) {
  if (!value || typeof value !== 'object') {
    return value == null ? 'unknown' : String(value);
  }

  if (typeof value.type === 'string' && value.type.trim()) {
    return value.type;
  }

  if (typeof value.event === 'string' && value.event.trim()) {
    return value.event;
  }

  return 'item';
}

export function markRuntimeSnapshotInterrupted(runtime, reason) {
  const nextRuntime = normalizeRuntimeSnapshot(runtime);
  const interruptedMessage = `${reason} before the running turn finished`;
  nextRuntime.source = 'appServer';
  nextRuntime.turnStatus = 'interrupted';
  nextRuntime.activeTurnId = null;
  nextRuntime.realtime = {
    ...nextRuntime.realtime,
    status: 'interrupted',
    lastError: interruptedMessage,
    closeReason: reason,
  };
  return nextRuntime;
}

export function shouldFallbackToRolloutFile(thread, error) {
  if (!thread?.path) {
    return false;
  }

  return /failed to locate rollout/i.test(error?.message ?? '');
}

export function shouldFallbackToCachedThread(thread, error) {
  if (!thread?.id) {
    return false;
  }

  return /not materialized yet|includeTurns is unavailable/i.test(error?.message ?? '');
}

export function shouldIgnoreRolloutRefreshError(error) {
  return error?.code === 'ENOENT';
}

export function mergeThreadSnapshot(thread, rolloutThread) {
  if (!thread) {
    return sanitizeThread(rolloutThread);
  }

  return sanitizeThread({
    ...thread,
    createdAt: thread.createdAt ?? rolloutThread?.createdAt ?? null,
    updatedAt: Math.max(thread.updatedAt ?? 0, rolloutThread?.updatedAt ?? 0),
    path: thread.path ?? rolloutThread?.path ?? null,
    cwd: thread.cwd ?? rolloutThread?.cwd ?? null,
    name: thread.name ?? thread.preview ?? rolloutThread?.name ?? thread.id,
    preview: thread.preview ?? rolloutThread?.preview ?? '',
    turns: rolloutThread?.turns ?? thread.turns ?? [],
  });
}

export function buildRolloutSignatureKey(signature) {
  return JSON.stringify({
    path: signature?.path ?? null,
    size: Number(signature?.size ?? 0),
    mtimeMs: Number(signature?.mtimeMs ?? 0),
  });
}

export function areRuntimeSnapshotsEqual(left, right) {
  return JSON.stringify(normalizeRuntimeSnapshot(left)) === JSON.stringify(normalizeRuntimeSnapshot(right));
}

export function isAppServerRuntimeSnapshot(runtime) {
  return normalizeRuntimeSnapshot(runtime).source !== 'externalRollout';
}

export function shouldStartTurnWithoutResume(error) {
  return /no rollout found for thread id/i.test(error?.message ?? '');
}

export function isApprovalRequest(message) {
  return (
    message?.method === 'item/commandExecution/requestApproval' ||
    message?.method === 'item/fileChange/requestApproval' ||
    message?.method === 'item/permissions/requestApproval'
  );
}

export function normalizeApprovalRequest(message) {
  const params = message?.params ?? {};
  switch (message?.method) {
    case 'item/commandExecution/requestApproval':
      return normalizeApprovalRecord({
        id: message.id,
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        itemId: params.itemId ?? null,
        kind: 'commandExecution',
        summary: summarizeCommandApproval(params),
        detail: {
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          reason: params.reason ?? null,
        },
        status: 'pending',
        createdAt: nowInSeconds(),
      });
    case 'item/fileChange/requestApproval':
      return normalizeApprovalRecord({
        id: message.id,
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        itemId: params.itemId ?? null,
        kind: 'fileChange',
        summary:
          params.reason ??
          (params.grantRoot ? `Allow writes under ${params.grantRoot}` : 'Approve file changes'),
        detail: {
          reason: params.reason ?? null,
          grantRoot: params.grantRoot ?? null,
        },
        status: 'pending',
        createdAt: nowInSeconds(),
      });
    case 'item/permissions/requestApproval':
      return normalizeApprovalRecord({
        id: message.id,
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        itemId: params.itemId ?? null,
        kind: 'permissions',
        summary: params.reason ?? 'Approve additional permissions',
        detail: {
          reason: params.reason ?? null,
          permissions: params.permissions ?? null,
        },
        status: 'pending',
        createdAt: nowInSeconds(),
      });
    default:
      throw new Error(`Unsupported approval request method: ${message?.method ?? 'unknown'}`);
  }
}

export function summarizeCommandApproval(params) {
  const command = Array.isArray(params?.command)
    ? params.command.join(' ')
    : String(params?.command ?? '').trim();
  if (command) {
    return `Run ${command}`;
  }

  if (params?.reason) {
    return String(params.reason);
  }

  return 'Approve command execution';
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

export function extractThreadDescriptorFromNotification(message) {
  const params = message?.params;
  if (!params || typeof params !== 'object') {
    return null;
  }

  if (params.thread && typeof params.thread === 'object') {
    return sanitizeThread(params.thread);
  }

  const threadId = normalizeThreadId(params.threadId ?? params.id ?? message?.threadId);
  if (!threadId) {
    return null;
  }

  return sanitizeThread({
    id: threadId,
    source: params.source ?? null,
    agentNickname: params.agentNickname ?? null,
    agentRole: params.agentRole ?? null,
    turns: [],
  });
}

export function extractParentThreadId(thread) {
  return normalizeThreadId(thread?.source?.subAgent?.thread_spawn?.parent_thread_id);
}

export function normalizeThreadId(threadId) {
  if (typeof threadId !== 'string') {
    return null;
  }

  const normalizedThreadId = threadId.trim();
  return normalizedThreadId || null;
}

export function normalizeThreadIdList(threadIds) {
  if (!Array.isArray(threadIds)) {
    return [];
  }

  return threadIds.map((threadId) => normalizeThreadId(threadId)).filter(Boolean);
}

export function normalizeApprovalPolicy(approvalPolicy) {
  if (typeof approvalPolicy !== 'string') {
    return null;
  }

  const normalizedApprovalPolicy = approvalPolicy.trim();
  return normalizedApprovalPolicy || null;
}

export function normalizeSandboxMode(sandboxMode) {
  switch (sandboxMode) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return sandboxMode;
    default:
      return null;
  }
}

export function createSandboxPolicy(sandboxMode) {
  switch (sandboxMode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write':
      return { type: 'workspaceWrite' };
    case 'read-only':
      return {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      };
    default:
      return null;
  }
}
