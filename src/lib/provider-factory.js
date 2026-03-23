import { JsonRpcClient } from './json-rpc-client.js';
import { CodexAppServer } from './codex-app-server.js';
import { CodexSessionService } from './codex-session-service.js';
import { CodexProvider } from './codex-provider.js';
import { AgentApiProvider } from './agent-api-provider.js';
import { ClaudeSdkProvider } from './claude-sdk-provider.js';
import { ClaudeSdkSessionIndex } from './claude-sdk-session-index.js';

export function createProvider({ config, activityStore, runtimeStore, cwd = process.cwd() }) {
  if (config.provider === 'claude-sdk') {
    return new ClaudeSdkProvider({
      activityStore,
      runtimeStore,
      cwd,
      sessionIndex: new ClaudeSdkSessionIndex({
        filePath: config.claudeSessionIndexPath,
      }),
    });
  }

  if (config.provider === 'agentapi') {
    return new AgentApiProvider({
      activityStore,
      baseUrl: config.agentApiBaseUrl,
    });
  }

  const codexAppServer = new CodexAppServer({
    codexBin: config.codexBin,
    codexArgs: [
      ...buildCodexAppServerCliArgs(config),
      'app-server',
      '--listen',
      `ws://127.0.0.1:${config.codexPort}`,
    ],
    port: config.codexPort,
    cwd,
  });

  const client = new JsonRpcClient(codexAppServer.url);
  const sessionService = new CodexSessionService({
    client,
    activityStore,
    runtimeStore,
    approvalPolicy: config.codexApprovalPolicy,
    sandboxMode: config.codexSandboxMode,
  });

  return new CodexProvider({
    appServer: codexAppServer,
    client,
    sessionService,
    initializeParams: {
      clientInfo: { name: 'web-agent-console-codex', version: '0.0.0' },
      capabilities: {},
    },
  });
}

function buildCodexAppServerCliArgs(config) {
  const args = [];

  if (config.codexSandboxMode) {
    args.push('-s', config.codexSandboxMode);
  }

  if (config.codexApprovalPolicy) {
    args.push('-a', config.codexApprovalPolicy);
  }

  return args;
}
