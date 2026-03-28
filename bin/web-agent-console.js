#!/usr/bin/env node

import { spawn } from 'node:child_process';
import packageJson from '../package.json' with { type: 'json' };
import { formatCliHelp, parseCliArgs } from '../src/lib/cli.js';

try {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.showHelp) {
    console.log(formatCliHelp({ command: 'web-agent-console' }));
    process.exit(0);
  }

  if (parsed.showVersion) {
    console.log(packageJson.version);
    process.exit(0);
  }

  if (parsed.command === 'doctor') {
    const { formatDoctorReport, runDoctor } = await import('../src/lib/doctor.js');
    const report = await runDoctor({
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...parsed.env,
      },
      fix: parsed.fix,
    });
    process.stdout.write(formatDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  }

  const { installShutdownHandlers, startWebAgentConsole } = await import(
    '../src/lib/web-agent-console-runtime.js'
  );
  const runtime = await startWebAgentConsole({
    env: {
      ...process.env,
      ...parsed.env,
    },
  });

  installShutdownHandlers(runtime.shutdown);

  console.log(`[web-agent-console] listening on ${runtime.url}`);

  if (parsed.openBrowser) {
    try {
      await openBrowser(runtime.url);
    } catch (error) {
      console.error(`[web-agent-console] failed to open browser: ${error.message}`);
    }
  }
} catch (error) {
  console.error(`[web-agent-console] ${error.message}`);
  process.exit(1);
}

async function openBrowser(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], {
      stdio: 'ignore',
      detached: true,
    });

    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
