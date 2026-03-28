import { installShutdownHandlers, startWebAgentConsole } from './lib/web-agent-console-runtime.js';

const runtime = await startWebAgentConsole();

installShutdownHandlers(runtime.shutdown);
