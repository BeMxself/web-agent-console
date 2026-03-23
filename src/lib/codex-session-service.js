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

const CODEX_SANDBOX_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'read-only', label: '只读' }),
  Object.freeze({ value: 'workspace-write', label: '工作区可写' }),
  Object.freeze({ value: 'danger-full-access', label: '完全访问' }),
]);

export class CodexSessionService extends SessionService {
  constructor({
    client,
    activityStore,
    runtimeStore,
    approvalPolicy = null,
    sandboxMode = null,
  }) {
    const normalizedSandboxMode = normalizeSandboxMode(sandboxMode);
    super({
      activityStore,
      runtimeStore,
      sessionOptions: {
        ...DEFAULT_SESSION_OPTIONS,
        attachmentCapabilities: CODEX_ATTACHMENT_CAPABILITIES,
        sandboxModeOptions: CODEX_SANDBOX_MODE_OPTIONS,
        defaults: {
          ...DEFAULT_SESSION_OPTIONS.defaults,
          ...(normalizedSandboxMode ? { sandboxMode: normalizedSandboxMode } : {}),
        },
        ...(normalizedSandboxMode
          ? {
              runtimeContext: {
                sandboxMode: normalizedSandboxMode,
              },
            }
          : {}),
      },
    });
    this.client = client;
    this.approvalPolicy = normalizeApprovalPolicy(approvalPolicy);
    this.sandboxMode = normalizedSandboxMode;
    this.threadIndex = new Map();
    this.threadParentById = new Map();
    this.threadStatusById = new Map();
    this.externalRolloutSignatureByThread = new Map();

    this.client.onNotification((message) => {
      this.captureThreadTopologyFromNotification(message);
      const event = mapCodexNotification(message);
      if (!event) {
        return;
      }

      this.captureRuntimeEvent(event);
      this.publishEvent(event);
    });

    this.client.onRequest?.((message) => {
      if (!isApprovalRequest(message)) {
        return undefined;
      }

      return this.handleApprovalRequest(message);
    });
  }

  onThreadSettingsChanged(threadId, settings) {
    const cachedThread = this.threadIndex.get(threadId);
    if (cachedThread) {
      this.threadIndex.set(threadId, attachSessionSettings(cachedThread, settings));
    }
  }

  async listSessions() {
    await this.ensureRuntimeStoreLoaded();
    const result = await this.client.request('thread/list', { archived: false });
    const sanitizedThreads = sanitizeThreads(result.data ?? []);
    this.rememberThreads(sanitizedThreads);
    await this.refreshExternalRuntimeSnapshots({
      threadIds: sanitizedThreads.map((thread) => thread.id),
      publishEvents: false,
    });
    const threads = this.decorateThreadsWithState(sanitizedThreads);
    this.rememberThreads(threads);
    return {
      ...result,
      data: threads,
    };
  }

  async listProjects() {
    await this.ensureRuntimeStoreLoaded();
    const [active, archived, activity] = await Promise.all([
      this.client.request('thread/list', { archived: false }),
      this.client.request('thread/list', { archived: true }),
      this.activityStore.load(),
    ]);
    const sanitizedActiveThreads = sanitizeThreads(active.data ?? []);
    const sanitizedArchivedThreads = sanitizeThreads(archived.data ?? []);
    this.rememberThreads(sanitizedActiveThreads);
    this.rememberThreads(sanitizedArchivedThreads);
    await this.refreshExternalRuntimeSnapshots({
      threadIds: [...sanitizedActiveThreads, ...sanitizedArchivedThreads].map((thread) => thread.id),
      publishEvents: false,
    });
    const activeThreads = this.decorateThreadsWithState(sanitizedActiveThreads);
    const archivedThreads = this.decorateThreadsWithState(sanitizedArchivedThreads);
    this.rememberThreads(activeThreads);
    this.rememberThreads(archivedThreads);

    return {
      projects: buildProjects(
        activeThreads,
        archivedThreads,
        activity.projects ?? {},
        [...this.threadIndex.values()],
      ),
    };
  }

  async readSession(threadId) {
    await this.ensureRuntimeStoreLoaded();
    try {
      const result = await this.client.request('thread/read', {
        threadId,
        includeTurns: true,
      });
      const sanitizedThread = sanitizeThread(result.thread);
      this.rememberThreads([sanitizedThread]);
      const thread = this.decorateThreadWithState(sanitizedThread, {
        includePendingApprovals: true,
      });
      this.rememberThreads([thread]);
      return {
        ...result,
        thread,
      };
    } catch (error) {
      const cachedThread = this.threadIndex.get(threadId);
      if (shouldFallbackToCachedThread(cachedThread, error)) {
        return {
          thread: {
            ...cachedThread,
            turns: cachedThread.turns ?? [],
          },
        };
      }

      if (!shouldFallbackToRolloutFile(cachedThread, error)) {
        throw error;
      }

      return {
        thread: this.decorateThreadWithState(sanitizeThread(await readThreadFromRolloutFile(cachedThread)), {
          includePendingApprovals: true,
        }),
      };
    }
  }

  async startSession({ cwd } = {}) {
    await this.ensureRuntimeStoreLoaded();
    const payload = {
      cwd: cwd ?? null,
      experimentalRawEvents: false,
    };
    if (this.approvalPolicy) {
      payload.approvalPolicy = this.approvalPolicy;
    }
    if (this.sandboxMode) {
      payload.sandbox = this.sandboxMode;
    }

    const result = await this.client.request('thread/start', payload);
    const sanitizedThread = sanitizeThread(result.thread);
    this.rememberThreads([sanitizedThread]);
    const thread = this.decorateThreadWithState(sanitizedThread, {
      includePendingApprovals: true,
    });
    this.rememberThreads([thread]);
    return {
      ...result,
      thread,
    };
  }

  async resumeSession(threadId) {
    await this.ensureRuntimeStoreLoaded();
    const result = await this.client.request('thread/resume', { threadId });
    const sanitizedThread = sanitizeThread(result.thread);
    this.rememberThreads([sanitizedThread]);
    const thread = this.decorateThreadWithState(sanitizedThread, {
      includePendingApprovals: true,
    });
    this.rememberThreads([thread]);
    return {
      ...result,
      thread,
    };
  }

  async startTurn(threadId, turnRequestOrText, settings = null) {
    await this.ensureRuntimeStoreLoaded();
    try {
      await this.resumeSession(threadId);
    } catch (error) {
      if (!shouldStartTurnWithoutResume(error)) {
        throw error;
      }
    }

    const normalizedTurnRequest = normalizeTurnRequestInput(turnRequestOrText, settings);
    validateCodexAttachments(normalizedTurnRequest.attachments);
    const payload = {
      threadId,
      input: [
        { type: 'text', text: normalizedTurnRequest.text },
        ...mapCodexAttachmentsToInput(normalizedTurnRequest.attachments),
      ],
    };
    if (this.approvalPolicy) {
      payload.approvalPolicy = this.approvalPolicy;
    }
    const sandboxPolicy = createSandboxPolicy(
      normalizeSandboxMode(normalizedTurnRequest.sandboxMode) ?? this.sandboxMode,
    );
    if (sandboxPolicy) {
      payload.sandboxPolicy = sandboxPolicy;
    }
    if (normalizedTurnRequest.model) {
      payload.model = normalizedTurnRequest.model;
    }
    if (normalizedTurnRequest.reasoningEffort) {
      payload.reasoningEffort = normalizedTurnRequest.reasoningEffort;
    }

    return await this.client.request('turn/start', payload);
  }

  async interruptTurn(threadId, turnId) {
    await this.ensureRuntimeStoreLoaded();
    return await this.client.request('turn/interrupt', {
      threadId,
      turnId,
    });
  }

  async markActiveSessionsInterrupted(reason = 'app-server restarted') {
    await this.ensureRuntimeStoreLoaded();
    const threadIds = [];

    for (const [threadId, runtime] of this.runtimeByThread.entries()) {
      if (!isRuntimeSnapshotActive(runtime) || !isAppServerRuntimeSnapshot(runtime)) {
        continue;
      }

      const nextRuntime = markRuntimeSnapshotInterrupted(runtime, reason);
      this.runtimeByThread.set(threadId, nextRuntime);
      const cachedThread = this.threadIndex.get(threadId);
      if (cachedThread) {
        this.threadIndex.set(threadId, attachRuntimeSnapshot(cachedThread, nextRuntime));
      }
      await this.persistRuntimeSnapshot(threadId);
      this.publishRuntimeReconciled(threadId, nextRuntime);
      threadIds.push(threadId);
    }

    return { ok: true, threadIds };
  }

  async refreshExternalRuntimeSnapshots({ threadIds = null, publishEvents = true } = {}) {
    await this.ensureRuntimeStoreLoaded();
    const candidates = this.getExternalRolloutCandidates(threadIds);
    const changes = [];

    for (const thread of candidates) {
      const currentRuntime = normalizeRuntimeSnapshot(this.runtimeByThread.get(thread.id));
      if (isAppServerRuntimeSnapshot(currentRuntime) && isRuntimeSnapshotActive(currentRuntime)) {
        continue;
      }

      let snapshot = null;
      try {
        snapshot = await readRolloutThreadSnapshot(thread);
      } catch (error) {
        if (shouldIgnoreRolloutRefreshError(error)) {
          continue;
        }

        throw error;
      }

      const signatureKey = buildRolloutSignatureKey(snapshot.signature);
      const previousSignatureKey = this.externalRolloutSignatureByThread.get(thread.id) ?? null;
      this.externalRolloutSignatureByThread.set(thread.id, signatureKey);

      const mergedThread = mergeThreadSnapshot(this.threadIndex.get(thread.id), snapshot.thread);
      this.threadIndex.set(thread.id, attachRuntimeSnapshot(mergedThread, currentRuntime));

      const nextRuntime = snapshot.runtime
        ? normalizeRuntimeSnapshot(snapshot.runtime)
        : currentRuntime.source === 'externalRollout'
          ? normalizeRuntimeSnapshot({})
          : null;
      const progressChanged =
        previousSignatureKey != null &&
        previousSignatureKey !== signatureKey &&
        currentRuntime.source === 'externalRollout' &&
        isRuntimeSnapshotActive(currentRuntime);

      if (!nextRuntime) {
        if (publishEvents && progressChanged) {
          this.publishRuntimeReconciled(thread.id, currentRuntime);
          changes.push({ threadId: thread.id, runtime: currentRuntime, progressChanged: true });
        }
        continue;
      }

      const runtimeChanged = !areRuntimeSnapshotsEqual(currentRuntime, nextRuntime);
      if (!runtimeChanged && !progressChanged) {
        continue;
      }

      this.runtimeByThread.set(thread.id, nextRuntime);
      this.threadIndex.set(thread.id, attachRuntimeSnapshot(mergedThread, nextRuntime));
      if (runtimeChanged) {
        await this.persistRuntimeSnapshot(thread.id);
      }
      if (publishEvents) {
        this.publishRuntimeReconciled(thread.id, nextRuntime);
      }
      changes.push({ threadId: thread.id, runtime: nextRuntime, progressChanged });
    }

    return { ok: true, changes };
  }

  async addFocusedSession(projectId, threadId) {
    await this.activityStore.addFocusedSession(projectId, threadId);
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
    const normalizedName = String(name ?? '').trim();
    const result = await this.client.request('thread/name/set', {
      threadId,
      name: normalizedName,
    });
    const cachedThread = this.threadIndex.get(threadId) ?? { id: threadId };
    const renamedThread = {
      ...cachedThread,
      ...sanitizeThread(result?.thread ?? {}),
      id: threadId,
      name: normalizedName,
      updatedAt:
        result?.thread?.updatedAt ??
        Math.max(cachedThread.updatedAt ?? 0, nowInSeconds()),
    };
    this.rememberThreads([renamedThread]);
    return {
      ...result,
      thread: renamedThread,
    };
  }

  async removeFocusedSession(projectId, threadId) {
    await this.activityStore.removeFocusedSession(projectId, threadId);
    return { ok: true };
  }

  async setProjectCollapsed(projectId, collapsed) {
    await this.activityStore.setCollapsed(projectId, collapsed);
    return { ok: true };
  }

  async createSessionInProject(projectId) {
    await this.activityStore.addProject(projectId);
    const result = await this.startSession({ cwd: projectId });
    await this.activityStore.addFocusedSession(projectId, result.thread.id);
    return result;
  }

  async handleApprovalRequest(message) {
    await this.ensureRuntimeStoreLoaded();
    const approval = this.remapApprovalToDisplayThread(normalizeApprovalRequest(message));
    const pendingAction = await this.upsertPendingAction({
      id: approval.id,
      threadId: approval.threadId,
      originThreadId: approval.originThreadId,
      turnId: approval.turnId,
      itemId: approval.itemId,
      kind: 'tool_approval',
      summary: approval.summary,
      payload: {
        approvalKind: approval.kind,
        detail: approval.detail,
      },
      status: approval.status,
      createdAt: approval.createdAt,
      resolvedAt: approval.resolvedAt,
      resolutionSource: approval.resolutionSource,
    });

    if (this.approvalMode === 'auto-approve') {
      const { pendingAction: autoApproved } = await this.finalizePendingAction(pendingAction.id, {
        status: 'auto-approved',
        resolutionSource: 'auto',
        result: createApprovalResolution({
          ...pendingAction,
          status: 'auto-approved',
          resolutionSource: 'auto',
        }),
      });
      return createApprovalResolution(autoApproved);
    }

    const waiter = this.createPendingActionWaiter(pendingAction.id);
    this.publishPendingActionRequested(pendingAction);
    return await waiter.promise;
  }

  rememberThreads(threads) {
    for (const thread of threads) {
      if (thread?.id) {
        const sanitizedThread = sanitizeThread(thread);
        this.registerThreadTopology(sanitizedThread);
        this.threadIndex.set(
          sanitizedThread.id,
          applyThreadStatusOverride(sanitizedThread, this.threadStatusById),
        );
      }
    }
  }

  captureThreadTopologyFromNotification(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.method === 'thread/started') {
      const thread = extractThreadDescriptorFromNotification(message);
      if (thread) {
        this.registerThreadTopology(thread);
      }
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      this.registerCollabAgentTopology(message.params?.item ?? message.params, message.params?.threadId ?? null);
    }
  }

  registerThreadTopology(thread) {
    if (!thread?.id) {
      return;
    }

    const parentThreadId = extractParentThreadId(thread);
    if (parentThreadId) {
      this.registerThreadParent(thread.id, parentThreadId);
    }

    for (const turn of thread.turns ?? []) {
      for (const item of turn?.items ?? []) {
        this.registerCollabAgentTopology(item, thread.id);
      }
    }
  }

  registerCollabAgentTopology(item, fallbackSenderThreadId = null) {
    if (!item || typeof item !== 'object') {
      return;
    }

    const itemType = item.type ?? item.itemType ?? null;
    if (itemType !== 'collabAgentToolCall') {
      return;
    }

    const parentThreadId = item.senderThreadId ?? fallbackSenderThreadId ?? null;
    if (!parentThreadId) {
      return;
    }

    const childThreadIds = new Set([
      ...normalizeThreadIdList(item.receiverThreadIds),
      ...Object.keys(item.agentsStates ?? {}),
    ]);

    for (const childThreadId of childThreadIds) {
      this.registerThreadParent(childThreadId, parentThreadId);
    }
  }

  registerThreadParent(childThreadId, parentThreadId) {
    const childId = normalizeThreadId(childThreadId);
    const parentId = normalizeThreadId(parentThreadId);
    if (!childId || !parentId || childId === parentId) {
      return;
    }

    const resolvedParentId = this.resolveDisplayThreadId(parentId);
    if (resolvedParentId === childId) {
      return;
    }

    if (this.threadParentById.get(childId) === parentId) {
      return;
    }

    this.threadParentById.set(childId, parentId);
    this.reconcileApprovalThreadIds({ republishPending: true });
  }

  resolveDisplayThreadId(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const visited = new Set();
    let currentThreadId = normalizedThreadId;

    while (this.threadParentById.has(currentThreadId) && !visited.has(currentThreadId)) {
      visited.add(currentThreadId);
      currentThreadId = this.threadParentById.get(currentThreadId) ?? currentThreadId;
    }

    return currentThreadId;
  }

  reconcileApprovalThreadIds({ republishPending = false, persist = true } = {}) {
    for (const [approvalId, pendingAction] of this.pendingActionsById.entries()) {
      const nextApproval = this.remapApprovalToDisplayThread(pendingAction);
      if (
        nextApproval.threadId === pendingAction.threadId &&
        nextApproval.originThreadId === pendingAction.originThreadId
      ) {
        continue;
      }

      this.pendingActionsById.set(approvalId, nextApproval);
      if (persist) {
        this.persistApprovalRecordLater(nextApproval);
      }
      if (republishPending && nextApproval.status === 'pending') {
        this.publishPendingActionRequested(nextApproval);
      }
    }
  }

  remapApprovalToDisplayThread(approval) {
    const originThreadId = normalizeThreadId(approval?.originThreadId ?? approval?.threadId);
    const displayThreadId = this.resolveDisplayThreadId(originThreadId) ?? originThreadId;

    const approvalRecord = createApprovalRecordFromPendingAction(approval) ?? approval;
    return normalizePendingActionRecord({
      ...approval,
      summary: approvalRecord?.summary ?? approval?.summary ?? '',
      payload: {
        approvalKind: approvalRecord?.kind ?? approval?.payload?.approvalKind ?? 'unknown',
        detail: approvalRecord?.detail ?? approval?.payload?.detail ?? {},
      },
      threadId: displayThreadId,
      originThreadId,
    });
  }

  decorateThreadsWithState(
    threads,
    options = { includePendingApprovals: true, includePendingQuestions: true },
  ) {
    return threads.map((thread) => this.decorateThreadWithState(thread, options));
  }

  decorateThreadWithState(
    thread,
    { includePendingApprovals = true, includePendingQuestions = includePendingApprovals } = {},
  ) {
    const threadWithStatus = applyThreadStatusOverride(thread, this.threadStatusById);
    return this.decorateThreadWithSharedState(threadWithStatus, {
      includePendingApprovals,
      includePendingQuestions,
    });
  }

  captureRuntimeEvent(event) {
    const threadId = event?.threadId ?? event?.payload?.threadId;
    if (!threadId) {
      return;
    }

    const nextRuntime = applyRuntimeEvent(
      normalizeRuntimeSnapshot(this.runtimeByThread.get(threadId)),
      event,
    );
    this.runtimeByThread.set(threadId, nextRuntime);

    const cachedThread = this.threadIndex.get(threadId);
    if (cachedThread) {
      this.threadIndex.set(threadId, attachRuntimeSnapshot(cachedThread, nextRuntime));
    }
    void this.persistRuntimeSnapshot(threadId);

    if (event?.type === 'thread_status_changed') {
      this.threadStatusById.set(threadId, sanitizeThreadStatus(event.payload?.status));
      const thread = this.threadIndex.get(threadId);
      if (thread) {
        this.threadIndex.set(
          threadId,
          attachPendingActionSnapshot(
            attachRuntimeSnapshot(
              applyThreadStatusOverride(thread, this.threadStatusById),
              nextRuntime,
            ),
            {
              pendingApprovals: this.listPendingApprovals(threadId),
              pendingQuestions: this.listPendingQuestions(threadId),
              includePendingApprovals: Array.isArray(thread.pendingApprovals),
            },
          ),
        );
      }
    }
  }

  getExternalRolloutCandidates(threadIds = null) {
    const normalizedIds = Array.isArray(threadIds)
      ? [...new Set(threadIds.map((threadId) => normalizeThreadId(threadId)).filter(Boolean))]
      : null;
    const candidates =
      normalizedIds?.map((threadId) => this.threadIndex.get(threadId)).filter(Boolean) ??
      [...this.threadIndex.values()];

    return candidates
      .map((thread) => sanitizeThread(thread))
      .filter((thread) => typeof thread?.path === 'string' && thread.path.trim());
  }
}

function sanitizeThreads(threads) {
  return threads.map((thread) => sanitizeThread(thread));
}

function sanitizeThread(thread) {
  if (!thread || typeof thread !== 'object') {
    return thread;
  }

  const { worktree: _worktree, ...rest } = thread;
  return {
    ...rest,
    turns: Array.isArray(rest.turns) ? rest.turns.map((turn) => sanitizeTurn(turn)) : rest.turns,
  };
}

function sanitizeTurn(turn) {
  if (!turn || typeof turn !== 'object') {
    return turn;
  }

  const { worktree: _worktree, ...rest } = turn;
  return {
    ...rest,
    items: Array.isArray(rest.items) ? rest.items.map((item) => sanitizeTurnItem(item)) : rest.items,
  };
}

function sanitizeTurnItem(item) {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const { worktree: _worktree, ...rest } = item;
  return {
    ...rest,
  };
}

function applyRuntimeEvent(runtime, event) {
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

function summarizeRuntimeItem(value) {
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

function markRuntimeSnapshotInterrupted(runtime, reason) {
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

function shouldFallbackToRolloutFile(thread, error) {
  if (!thread?.path) {
    return false;
  }

  return /failed to locate rollout/i.test(error?.message ?? '');
}

function shouldFallbackToCachedThread(thread, error) {
  if (!thread?.id) {
    return false;
  }

  return /not materialized yet|includeTurns is unavailable/i.test(error?.message ?? '');
}

function shouldIgnoreRolloutRefreshError(error) {
  return error?.code === 'ENOENT';
}

function mergeThreadSnapshot(thread, rolloutThread) {
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

function buildRolloutSignatureKey(signature) {
  return JSON.stringify({
    path: signature?.path ?? null,
    size: Number(signature?.size ?? 0),
    mtimeMs: Number(signature?.mtimeMs ?? 0),
  });
}

function areRuntimeSnapshotsEqual(left, right) {
  return JSON.stringify(normalizeRuntimeSnapshot(left)) === JSON.stringify(normalizeRuntimeSnapshot(right));
}

function isAppServerRuntimeSnapshot(runtime) {
  return normalizeRuntimeSnapshot(runtime).source !== 'externalRollout';
}

function shouldStartTurnWithoutResume(error) {
  return /no rollout found for thread id/i.test(error?.message ?? '');
}

function isApprovalRequest(message) {
  return (
    message?.method === 'item/commandExecution/requestApproval' ||
    message?.method === 'item/fileChange/requestApproval' ||
    message?.method === 'item/permissions/requestApproval'
  );
}

function normalizeApprovalRequest(message) {
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

function summarizeCommandApproval(params) {
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

function extractThreadDescriptorFromNotification(message) {
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

function extractParentThreadId(thread) {
  return normalizeThreadId(thread?.source?.subAgent?.thread_spawn?.parent_thread_id);
}

function normalizeThreadId(threadId) {
  if (typeof threadId !== 'string') {
    return null;
  }

  const normalizedThreadId = threadId.trim();
  return normalizedThreadId || null;
}

function normalizeThreadIdList(threadIds) {
  if (!Array.isArray(threadIds)) {
    return [];
  }

  return threadIds.map((threadId) => normalizeThreadId(threadId)).filter(Boolean);
}

function normalizeApprovalPolicy(approvalPolicy) {
  if (typeof approvalPolicy !== 'string') {
    return null;
  }

  const normalizedApprovalPolicy = approvalPolicy.trim();
  return normalizedApprovalPolicy || null;
}

function normalizeSandboxMode(sandboxMode) {
  switch (sandboxMode) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return sandboxMode;
    default:
      return null;
  }
}

function createSandboxPolicy(sandboxMode) {
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
