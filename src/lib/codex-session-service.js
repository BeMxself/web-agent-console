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
  normalizeSessionAgentType,
  normalizeRuntimeSnapshot,
  nowInSeconds,
  sanitizeThreadStatus,
} from './session-service.js';
import { normalizeTurnRequestInput } from './turn-request.js';
import {
  createApprovalRecordFromPendingAction,
  normalizePendingActionRecord,
} from './runtime-store.js';


import {
  sanitizeThreads,
  sanitizeThread,
  sanitizeTurn,
  sanitizeTurnItem,
  applyRuntimeEvent,
  summarizeRuntimeItem,
  markRuntimeSnapshotInterrupted,
  shouldFallbackToRolloutFile,
  shouldFallbackToCachedThread,
  shouldIgnoreRolloutRefreshError,
  mergeThreadSnapshot,
  buildRolloutSignatureKey,
  areRuntimeSnapshotsEqual,
  isAppServerRuntimeSnapshot,
  shouldStartTurnWithoutResume,
  isApprovalRequest,
  normalizeApprovalRequest,
  summarizeCommandApproval,
  normalizeApprovalRecord,
  extractThreadDescriptorFromNotification,
  extractParentThreadId,
  normalizeThreadId,
  normalizeThreadIdList,
  normalizeApprovalPolicy,
  normalizeSandboxMode,
  createSandboxPolicy,
} from './codex-session-service-helpers.js';

const CODEX_SANDBOX_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'read-only', label: '只读' }),
  Object.freeze({ value: 'workspace-write', label: '工作区可写' }),
  Object.freeze({ value: 'danger-full-access', label: '完全访问' }),
]);

const CODEX_AGENT_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'default', label: '执行' }),
  Object.freeze({ value: 'plan', label: '计划' }),
]);

const DEFAULT_CODEX_COLLABORATION_MODEL =
  DEFAULT_SESSION_OPTIONS.modelOptions.find((option) => option.value)?.value ?? 'gpt-5.4';

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
        agentTypeOptions: CODEX_AGENT_TYPE_OPTIONS,
        defaults: {
          ...DEFAULT_SESSION_OPTIONS.defaults,
          agentType: 'default',
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

  normalizeSessionSettings(settings) {
    const normalized = super.normalizeSessionSettings(settings);
    return {
      ...normalized,
      agentType: normalizeCodexAgentType(settings?.agentType, { allowDefault: false }),
    };
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
    const collaborationMode = createCodexCollaborationMode(normalizedTurnRequest);
    if (collaborationMode) {
      payload.collaborationMode = collaborationMode;
    } else {
      if (normalizedTurnRequest.model) {
        payload.model = normalizedTurnRequest.model;
      }
      if (normalizedTurnRequest.reasoningEffort) {
        payload.reasoningEffort = normalizedTurnRequest.reasoningEffort;
      }
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

function normalizeCodexAgentType(value, { allowDefault = true } = {}) {
  const normalized = normalizeSessionAgentType(value)?.toLowerCase();
  if (normalized === 'plan') {
    return 'plan';
  }

  if (allowDefault && normalized === 'default') {
    return 'default';
  }

  return null;
}

function createCodexCollaborationMode(turnRequest) {
  const mode = normalizeCodexAgentType(turnRequest?.agentType);
  if (!mode) {
    return null;
  }

  return {
    mode,
    settings: {
      model: turnRequest?.model ?? DEFAULT_CODEX_COLLABORATION_MODEL,
      reasoning_effort: turnRequest?.reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
}
