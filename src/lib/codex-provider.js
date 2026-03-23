import { ProviderAdapter } from './provider-adapter.js';
import { normalizeTurnRequestInput } from './turn-request.js';

const RECOVERABLE_ERROR_PATTERN =
  /WebSocket is not open|WebSocket is not connected|readyState 3|ECONNREFUSED|connection closed/i;

export class CodexProvider extends ProviderAdapter {
  constructor({ appServer, client, sessionService, initializeParams }) {
    super({ providerId: 'codex' });
    this.appServer = appServer;
    this.client = client;
    this.sessionService = sessionService;
    this.initializeParams = initializeParams;
    this.recoveryPromise = null;
    this.lastRecoveryAttemptAt = 0;
  }

  async start() {
    await this.recover('connecting');
    return this.getStatus();
  }

  getStatus() {
    void this.sessionService.refreshExternalRuntimeSnapshots().catch(() => {});

    if (!this.client.isConnected?.() && !this.recoveryPromise) {
      this.maybeRecoverInBackground();
    }

    return super.getStatus();
  }

  subscribe(handler) {
    return this.sessionService.subscribe(handler);
  }

  async listProjects() {
    return await this.run(() => this.sessionService.listProjects());
  }

  async readSession(threadId) {
    return await this.run(() => this.sessionService.readSession(threadId));
  }

  async startTurn(threadId, turnRequestOrText, settings = null) {
    const normalizedTurnRequest = normalizeTurnRequestInput(turnRequestOrText, settings);
    return await this.run(() => this.sessionService.startTurn(threadId, normalizedTurnRequest));
  }

  async interruptTurn(threadId, turnId) {
    return await this.run(() => this.sessionService.interruptTurn(threadId, turnId));
  }

  async addFocusedSession(projectId, threadId) {
    return await this.run(() => this.sessionService.addFocusedSession(projectId, threadId));
  }

  async removeFocusedSession(projectId, threadId) {
    return await this.run(() => this.sessionService.removeFocusedSession(projectId, threadId));
  }

  async setProjectCollapsed(projectId, collapsed) {
    return await this.run(() => this.sessionService.setProjectCollapsed(projectId, collapsed));
  }

  async addProject(projectId) {
    return await this.run(() => this.sessionService.addProject(projectId));
  }

  async closeProject(projectId) {
    return await this.run(() => this.sessionService.closeProject(projectId));
  }

  async renameSession(threadId, name) {
    return await this.run(() => this.sessionService.renameSession(threadId, name));
  }

  async createSessionInProject(projectId) {
    return await this.run(() => this.sessionService.createSessionInProject(projectId));
  }

  async getApprovalMode() {
    return await this.run(() => this.sessionService.getApprovalMode());
  }

  async getSessionOptions() {
    return await this.run(() => this.sessionService.getSessionOptions());
  }

  async getSessionSettings(threadId) {
    return await this.run(() => this.sessionService.getSessionSettings(threadId));
  }

  async setSessionSettings(threadId, settings) {
    return await this.run(() => this.sessionService.setSessionSettings(threadId, settings));
  }

  async setApprovalMode(mode) {
    return await this.run(() => this.sessionService.setApprovalMode(mode));
  }

  async approveRequest(approvalId) {
    return await this.run(() => this.sessionService.approveRequest(approvalId));
  }

  async denyRequest(approvalId) {
    return await this.run(() => this.sessionService.denyRequest(approvalId));
  }

  async shutdown() {
    await this.client.close().catch(() => {});
    await this.appServer.stop().catch(() => {});
  }

  async run(operation) {
    try {
      await this.ensureReady();
      const result = await operation();
      this.markRequestSuccess();
      this.backendStatus = this.client.isConnected?.() ? 'connected' : this.backendStatus;
      return result;
    } catch (error) {
      if (!shouldRecoverFrom(error)) {
        this.markRequestError(error);
        throw error;
      }

      await this.recover('reconnecting');
      const result = await operation();
      this.markRequestSuccess();
      this.backendStatus = this.client.isConnected?.() ? 'connected' : this.backendStatus;
      return result;
    }
  }

  async ensureReady() {
    if (this.client.isConnected?.()) {
      return;
    }

    await this.recover('reconnecting');
  }

  maybeRecoverInBackground() {
    if (this.recoveryPromise) {
      return;
    }

    if (Date.now() - this.lastRecoveryAttemptAt < 1_500) {
      return;
    }

    void this.recover('reconnecting').catch(() => {});
  }

  async recover(nextStatus) {
    if (this.recoveryPromise) {
      return await this.recoveryPromise;
    }

    this.backendStatus = nextStatus;
    this.touch();
    this.lastRecoveryAttemptAt = Date.now();

    this.recoveryPromise = (async () => {
      try {
        let restartedManagedServer = false;
        await this.client.close().catch(() => {});

        if (this.appServer.isManagedProcessRunning?.()) {
          try {
            await this.tryReconnectExistingBackend();
          } catch {
            await this.restartManagedBackend();
            restartedManagedServer = true;
          }
        } else {
          await this.restartManagedBackend();
          restartedManagedServer = true;
        }

        if (restartedManagedServer) {
          await this.sessionService.markActiveSessionsInterrupted('app-server restarted');
        }

        this.lastError = null;
        this.backendStatus = 'connected';
        this.touch();
      } catch (error) {
        this.lastError = error.message;
        this.backendStatus = 'disconnected';
        this.requestsStatus = 'error';
        this.touch();
        throw error;
      } finally {
        this.recoveryPromise = null;
      }
    })();

    return await this.recoveryPromise;
  }

  async tryReconnectExistingBackend() {
    await this.client.connect();
    await this.client.request('initialize', this.initializeParams);
  }

  async restartManagedBackend() {
    await this.appServer.stop().catch(() => {});
    await this.appServer.start();
    await this.client.connect();
    await this.client.request('initialize', this.initializeParams);
  }
}

function shouldRecoverFrom(error) {
  return RECOVERABLE_ERROR_PATTERN.test(error?.message ?? '');
}
