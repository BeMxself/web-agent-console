const VALUE_FLAGS = new Map([
  ['--provider', 'WEB_AGENT_PROVIDER'],
  ['--host', 'RELAY_HOST'],
  ['--port', 'RELAY_PORT'],
  ['--password', 'WEB_AGENT_AUTH_PASSWORD'],
  ['--codex-bin', 'CODEX_BIN'],
  ['--sandbox', 'CODEX_SANDBOX_MODE'],
  ['--approval', 'CODEX_APPROVAL_POLICY'],
]);
const COMMANDS = new Set(['start', 'doctor']);

export function parseCliArgs(argv = []) {
  const env = {};
  let command = 'start';
  let commandExplicitlySet = false;
  let fix = false;
  let openBrowser = false;
  let showHelp = false;
  let showVersion = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('-')) {
      if (commandExplicitlySet) {
        throw new Error(`Unknown command: ${arg}`);
      }

      if (!COMMANDS.has(arg)) {
        throw new Error(`Unknown command: ${arg}`);
      }

      command = arg;
      commandExplicitlySet = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      showHelp = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      showVersion = true;
      continue;
    }

    if (arg === '--open') {
      openBrowser = true;
      continue;
    }

    if (arg === '--no-open') {
      openBrowser = false;
      continue;
    }

    if (arg === '--fix') {
      fix = true;
      continue;
    }

    const [flag, inlineValue] = arg.split('=', 2);
    const envKey = VALUE_FLAGS.get(flag);
    if (!envKey) {
      throw new Error(`Unknown option: ${arg}`);
    }

    const nextValue = argv[index + 1];
    const value = inlineValue ?? nextValue;
    if (!value || (inlineValue == null && value.startsWith('--'))) {
      throw new Error(`Missing value for ${flag}`);
    }

    env[envKey] = value;
    if (inlineValue == null) {
      index += 1;
    }
  }

  return {
    command,
    env,
    fix,
    openBrowser,
    showHelp,
    showVersion,
  };
}

export function formatCliHelp({ command = 'web-agent-console' } = {}) {
  return `Usage: ${command} [command] [options]

Start the local-first Web Agent Console and serve the browser UI from the current working directory.

Commands:
  start                 Start the Web Agent Console server (default)
  doctor                Check local Codex / Claude prerequisites and suggest safe fixes

Options:
  --provider <id>       Backend provider (codex, claude-sdk, agentapi)
  --host <host>         Relay host to bind (default: 127.0.0.1)
  --port <port>         Relay port to bind (default: 4318)
  --password <value>    Enable shared-password auth for the Web UI
  --codex-bin <path>    Override the codex executable path
  --sandbox <mode>      Codex sandbox mode passed to the managed app-server
  --approval <policy>   Codex approval policy passed to the managed app-server
  --open                Open the relay URL in the default browser after startup
  --no-open             Do not open the browser, even if enabled by shell defaults
  --fix                 With \`doctor\`, apply safe automatic fixes when available
  -h, --help            Show this help message
  -v, --version         Print the package version

Environment variables continue to work and are applied before CLI flag overrides:
  WEB_AGENT_PROVIDER, RELAY_HOST, RELAY_PORT, WEB_AGENT_AUTH_PASSWORD,
  CODEX_BIN, CODEX_SANDBOX_MODE, CODEX_APPROVAL_POLICY, CODEX_APP_SERVER_PORT
`;
}
