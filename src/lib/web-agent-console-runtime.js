import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { createProvider } from './provider-factory.js';
import { createHttpServer } from './http-server.js';
import { ActivityStore } from './activity-store.js';
import { RuntimeStore } from './runtime-store.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export async function startWebAgentConsole({
  cwd = process.cwd(),
  env = process.env,
  createProviderImpl = createProvider,
  createHttpServerImpl = createHttpServer,
  activityStoreFactory = ({ filePath }) => new ActivityStore({ filePath }),
  runtimeStoreFactory = ({ filePath }) => new RuntimeStore({ filePath }),
} = {}) {
  const config = getConfig(env);
  const activityStore = activityStoreFactory({
    filePath: config.activityStorePath,
  });
  const runtimeStore = runtimeStoreFactory({
    filePath: config.runtimeStorePath,
  });
  const provider = createProviderImpl({
    config,
    activityStore,
    runtimeStore,
    cwd,
  });
  const server = createHttpServerImpl({
    provider,
    publicDir: PUBLIC_DIR,
    config,
  });

  await provider.start().catch((error) => {
    console.error(
      `[web-agent-console] initial ${config.provider} backend start failed: ${error.message}`,
    );
  });

  server.listen(config.relayPort, config.relayHost);

  return {
    config,
    provider,
    server,
    url: getRelayUrl(config),
    async shutdown() {
      await provider.shutdown();
      if (typeof server.shutdown === 'function') {
        await server.shutdown();
        return;
      }

      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function installShutdownHandlers(shutdown, { exit = process.exit } = {}) {
  const handleSignal = async () => {
    await shutdown();
    exit(0);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

function getRelayUrl(config) {
  const visibleHost = config.relayHost === '0.0.0.0' ? '127.0.0.1' : config.relayHost;
  return `http://${visibleHost}:${config.relayPort}`;
}
