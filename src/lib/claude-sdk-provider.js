import { ProviderAdapter } from './provider-adapter.js';
import { ClaudeSdkSessionService } from './claude-sdk-session-service.js';
import { CLAUDE_ATTACHMENT_CAPABILITIES } from './claude-attachments.js';
import { cloneSessionOptions } from './session-service.js';
import { normalizeTurnRequestInput } from './turn-request.js';

export class ClaudeSdkProvider extends ProviderAdapter {
  constructor({ activityStore, runtimeStore, cwd, sessionIndex, claudeSdk, sessionService }) {
    super({ providerId: 'claude-sdk' });
    this.activityStore = activityStore;
    this.runtimeStore = runtimeStore;
    this.cwd = cwd;
    this.sessionIndex = sessionIndex;
    this.sessionService =
      sessionService ??
      new ClaudeSdkSessionService({
        activityStore,
        claudeSdk,
        runtimeStore,
        cwd,
        sessionIndex,
      });
  }

  async start() {
    await this.sessionService.markActiveSessionsInterrupted('claude-sdk backend restarted');
    this.backendStatus = 'connected';
    this.requestsStatus = 'idle';
    this.lastError = null;
    this.touch();
    return this.getStatus();
  }

  subscribe(handler) {
    return this.sessionService.subscribe(handler);
  }

  getIngressRoutes() {
    return [
      {
        method: 'POST',
        path: '/api/providers/claude/hooks',
        allowUnauthenticated: true,
        handle: async (context) => {
          context.assertLocalLoopback('Claude hook ingress only accepts local loopback traffic');
          context.assertHeaderValue({
            headerName: 'x-web-agent-hook-secret',
            expectedValue: context.config.claudeHookSecret,
            errorMessage: 'Invalid Claude hook secret',
          });
          const event = await context.readJsonBody();
          const data = await this.ingestExternalBridgeEvent({
            provider: 'claude',
            event,
            waitForResolution: context.req.headers['x-web-agent-wait-for-resolution'] === '1',
            remoteAddress: context.req.socket.remoteAddress ?? null,
          });

          return {
            statusCode: data?.resolution ? 200 : 202,
            body: data,
          };
        },
      },
    ];
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

  async setApprovalMode(mode) {
    return await this.run(() => this.sessionService.setApprovalMode(mode));
  }

  async getSessionOptions() {
    return await this.run(async () =>
      cloneSessionOptions({
        ...(await this.sessionService.getSessionOptions()),
        providerId: this.providerId,
        attachmentCapabilities: CLAUDE_ATTACHMENT_CAPABILITIES,
      }),
    );
  }

  async getSessionSettings(threadId) {
    return await this.run(() => this.sessionService.getSessionSettings(threadId));
  }

  async setSessionSettings(threadId, settings) {
    return await this.run(() => this.sessionService.setSessionSettings(threadId, settings));
  }

  async approveRequest(approvalId) {
    return await this.run(() => this.sessionService.approveRequest(approvalId));
  }

  async denyRequest(approvalId) {
    return await this.run(() => this.sessionService.denyRequest(approvalId));
  }

  async resolvePendingAction(actionId, resolution) {
    return await this.run(() => this.sessionService.resolvePendingAction(actionId, resolution));
  }

  async ingestExternalBridgeEvent(payload) {
    return await this.run(() => this.sessionService.ingestExternalBridgeEvent(payload));
  }

  async run(operation) {
    try {
      const result = await operation();
      this.markRequestSuccess();
      this.backendStatus = 'connected';
      this.touch();
      return result;
    } catch (error) {
      this.markRequestError(error);
      throw error;
    }
  }
}
