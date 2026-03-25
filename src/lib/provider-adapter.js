export class ProviderAdapter {
  constructor({ providerId = 'unknown' } = {}) {
    this.providerId = providerId;
    this.lastError = null;
    this.backendStatus = 'disconnected';
    this.requestsStatus = 'idle';
    this.updatedAt = new Date().toISOString();
  }

  async start() {
    return this.getStatus();
  }

  getStatus() {
    return {
      overall: this.backendStatus === 'connected' ? 'connected' : this.backendStatus,
      relay: {
        status: 'online',
      },
      backend: {
        status: this.backendStatus,
      },
      requests: {
        status: this.requestsStatus,
      },
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  subscribe() {
    return () => {};
  }

  getIngressRoutes() {
    return [];
  }

  async listProjects() {
    throw createProviderNotImplementedError(this, 'listProjects');
  }

  async readSession() {
    throw createProviderNotImplementedError(this, 'readSession');
  }

  async startTurn(_threadId, _turnRequest) {
    throw createProviderNotImplementedError(this, 'startTurn');
  }

  async interruptTurn() {
    throw createProviderNotImplementedError(this, 'interruptTurn');
  }

  async addFocusedSession() {
    throw createProviderNotImplementedError(this, 'addFocusedSession');
  }

  async removeFocusedSession() {
    throw createProviderNotImplementedError(this, 'removeFocusedSession');
  }

  async setProjectCollapsed() {
    throw createProviderNotImplementedError(this, 'setProjectCollapsed');
  }

  async addProject() {
    throw createProviderNotImplementedError(this, 'addProject');
  }

  async closeProject() {
    throw createProviderNotImplementedError(this, 'closeProject');
  }

  async renameSession() {
    throw createProviderNotImplementedError(this, 'renameSession');
  }

  async branchFromQuestion() {
    throw createProviderNotImplementedError(this, 'branchFromQuestion');
  }

  async rewriteInPlaceFromQuestion() {
    throw createProviderNotImplementedError(this, 'rewriteInPlaceFromQuestion');
  }

  async createSessionInProject() {
    throw createProviderNotImplementedError(this, 'createSessionInProject');
  }

  async getApprovalMode() {
    throw createProviderNotImplementedError(this, 'getApprovalMode');
  }

  async getSessionOptions() {
    throw createProviderNotImplementedError(this, 'getSessionOptions');
  }

  async getSessionSettings() {
    throw createProviderNotImplementedError(this, 'getSessionSettings');
  }

  async setSessionSettings() {
    throw createProviderNotImplementedError(this, 'setSessionSettings');
  }

  async setApprovalMode() {
    throw createProviderNotImplementedError(this, 'setApprovalMode');
  }

  async approveRequest() {
    throw createProviderNotImplementedError(this, 'approveRequest');
  }

  async denyRequest() {
    throw createProviderNotImplementedError(this, 'denyRequest');
  }

  async resolvePendingAction() {
    throw createProviderNotImplementedError(this, 'resolvePendingAction');
  }

  async ingestExternalBridgeEvent() {
    throw createProviderNotImplementedError(this, 'ingestExternalBridgeEvent');
  }

  async shutdown() {}

  markRequestSuccess() {
    this.requestsStatus = 'ready';
    this.lastError = null;
    this.touch();
  }

  markRequestError(error) {
    this.requestsStatus = 'error';
    this.lastError = error?.message ?? String(error);
    this.touch();
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }
}

export function createProviderNotImplementedError(instance, methodName) {
  return new Error(`${instance.constructor.name}.${methodName} is not implemented yet`);
}
