import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { createProvider } from './lib/provider-factory.js';
import { createHttpServer } from './lib/http-server.js';
import { ActivityStore } from './lib/activity-store.js';
import { RuntimeStore } from './lib/runtime-store.js';

const config = getConfig();
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const activityStore = new ActivityStore({
  filePath: config.activityStorePath,
});
const runtimeStore = new RuntimeStore({
  filePath: config.runtimeStorePath,
});

const provider = createProvider({
  config,
  activityStore,
  runtimeStore,
  cwd: process.cwd(),
});

const server = createHttpServer({
  provider,
  publicDir: join(__dirname, '../public'),
  config,
});

await provider.start().catch((error) => {
  console.error(
    `[web-agent-console] initial ${config.provider} backend start failed: ${error.message}`,
  );
});

server.listen(config.relayPort, config.relayHost);

async function shutdown() {
  await provider.shutdown();
  if (typeof server.shutdown === 'function') {
    await server.shutdown();
    return;
  }

  await new Promise((resolve) => server.close(resolve));
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
