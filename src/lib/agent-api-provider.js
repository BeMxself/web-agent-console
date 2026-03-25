import { basename } from 'node:path';
import {
  ProviderAdapter,
  createProviderNotImplementedError,
} from './provider-adapter.js';
import { cloneSessionOptions } from './session-service.js';

const AGENT_API_ATTACHMENT_CAPABILITIES = Object.freeze({
  maxAttachments: 0,
  maxBytesPerAttachment: 0,
  acceptedMimePatterns: Object.freeze([]),
  supportsNonImageFiles: false,
});

export class AgentApiProvider extends ProviderAdapter {
  constructor({ activityStore, baseUrl = null }) {
    super({ providerId: 'agentapi' });
    this.activityStore = activityStore;
    this.baseUrl = baseUrl;
    this.threadIndex = new Map();
    this.lastError = 'AgentApiProvider is not implemented yet.';
  }

  async start() {
    this.backendStatus = 'disconnected';
    this.requestsStatus = 'idle';
    this.touch();
    return this.getStatus();
  }

  async listProjects() {
    const activity = await this.activityStore.load();
    return {
      projects: buildProjects(activity.projects ?? {}, [...this.threadIndex.values()]),
    };
  }

  async readSession(threadId) {
    const thread = this.threadIndex.get(threadId);
    if (thread) {
      return { thread };
    }

    const error = createProviderNotImplementedError(this, 'readSession');
    this.markRequestError(error);
    throw error;
  }

  async startTurn(_threadId, _turnRequest) {
    const error = createProviderNotImplementedError(this, 'startTurn');
    this.markRequestError(error);
    throw error;
  }

  async interruptTurn() {
    const error = createProviderNotImplementedError(this, 'interruptTurn');
    this.markRequestError(error);
    throw error;
  }

  async addFocusedSession(projectId, threadId) {
    await this.activityStore.addFocusedSession(projectId, threadId);
    return { ok: true };
  }

  async removeFocusedSession(projectId, threadId) {
    await this.activityStore.removeFocusedSession(projectId, threadId);
    return { ok: true };
  }

  async setProjectCollapsed(projectId, collapsed) {
    await this.activityStore.setCollapsed(projectId, collapsed);
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
    const thread = this.threadIndex.get(threadId);
    if (!thread) {
      const error = createProviderNotImplementedError(this, 'renameSession');
      this.markRequestError(error);
      throw error;
    }

    const renamedThread = {
      ...thread,
      name: String(name ?? '').trim(),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.threadIndex.set(threadId, renamedThread);
    this.markRequestSuccess();
    return { thread: renamedThread };
  }

  async createSessionInProject(projectId) {
    await this.activityStore.addProject(projectId);
    const timestamp = Math.floor(Date.now() / 1000);
    const thread = {
      id: `agentapi-placeholder-${Date.now()}`,
      preview: '',
      ephemeral: false,
      modelProvider: 'agentapi',
      createdAt: timestamp,
      updatedAt: timestamp,
      status: { type: 'placeholder' },
      path: null,
      cwd: projectId,
      cliVersion: null,
      source: 'agentapi',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: 'Agent API Session',
      turns: [],
    };
    this.threadIndex.set(thread.id, thread);
    await this.activityStore.addFocusedSession(projectId, thread.id);
    return { thread };
  }

  async getApprovalMode() {
    const error = createProviderNotImplementedError(this, 'getApprovalMode');
    this.markRequestError(error);
    throw error;
  }

  async setApprovalMode() {
    const error = createProviderNotImplementedError(this, 'setApprovalMode');
    this.markRequestError(error);
    throw error;
  }

  async approveRequest() {
    const error = createProviderNotImplementedError(this, 'approveRequest');
    this.markRequestError(error);
    throw error;
  }

  async denyRequest() {
    const error = createProviderNotImplementedError(this, 'denyRequest');
    this.markRequestError(error);
    throw error;
  }

  async getSessionOptions() {
    return cloneSessionOptions({
      providerId: this.providerId,
      attachmentCapabilities: AGENT_API_ATTACHMENT_CAPABILITIES,
      rewriteCapabilities: {
        branch: false,
        inPlace: false,
      },
      modelOptions: [],
      reasoningEffortOptions: [],
      defaults: {
        model: null,
        reasoningEffort: null,
      },
    });
  }
}

function buildProjects(activityProjects, knownThreads) {
  const threadsById = new Map();
  for (const thread of knownThreads) {
    if (thread?.id) {
      threadsById.set(thread.id, thread);
    }
  }

  return Object.entries(activityProjects)
    .filter(([, project]) => !project?.hidden)
    .map(([projectId, project]) => {
      const focusedSessions = (project.focusedThreadIds ?? [])
        .map((threadId) => threadsById.get(threadId))
        .filter(Boolean);
      const updatedAt = Math.max(0, ...focusedSessions.map((thread) => thread.updatedAt ?? 0));

      return {
        id: projectId,
        cwd: projectId,
        displayName: basename(projectId) || projectId,
        collapsed: Boolean(project?.collapsed),
        focusedSessions,
        historySessions: {
          active: [],
          archived: [],
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
