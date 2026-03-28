import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function runDoctor({
  cwd = process.cwd(),
  env = process.env,
  fix = false,
  homeDir = env.HOME ?? null,
  nodeVersion = process.version,
  packageResolver = defaultPackageResolver,
  pathExists = existsSync,
  commandRunner = defaultCommandRunner,
} = {}) {
  const context = {
    cwd,
    env,
    homeDir,
    nodeVersion,
    packageResolver,
    pathExists,
    commandRunner,
  };

  const report = await collectDoctorReport(context);
  if (!fix) {
    return report;
  }

  return await applyDoctorFixes(report, context);
}

export function formatDoctorReport(report) {
  const lines = ['Web Agent Console doctor', ''];

  for (const check of report.checks) {
    lines.push(`${statusIcon(check.status)} ${check.label}: ${check.summary}`);
    if (check.suggestion) {
      lines.push(`  Suggestion: ${check.suggestion}`);
    }
    if (check.fix) {
      lines.push(`  Safe fix: ${formatCommand(check.fix.command, check.fix.args)}`);
    }
  }

  if (report.fixes?.length) {
    lines.push('');
    lines.push('Applied fixes:');
    for (const fix of report.fixes) {
      lines.push(`${statusIcon(fix.status)} ${fix.label}: ${fix.summary}`);
    }
  }

  lines.push('');
  lines.push(report.ok ? 'Doctor finished: no blocking issues detected.' : 'Doctor finished: blocking issues remain.');
  return `${lines.join('\n')}\n`;
}

async function collectDoctorReport(context) {
  const checks = [
    checkNodeVersion(context),
    await checkCodex(context),
    checkClaudeSdkPackage(context),
    await checkClaudeCodeCli(context),
    checkClaudeAuth(context),
  ];

  return {
    ok: checks.every((check) => check.status !== 'error'),
    checks,
    fixes: [],
  };
}

async function applyDoctorFixes(report, context) {
  const fixes = [];

  for (const check of report.checks) {
    if (check.status !== 'error' || !check.fix) {
      continue;
    }

    const result = await context.commandRunner(check.fix.command, check.fix.args, {
      cwd: context.cwd,
      env: context.env,
    });
    fixes.push({
      id: check.id,
      label: check.label,
      status: result.ok ? 'fixed' : 'failed',
      summary: result.ok
        ? `Ran ${formatCommand(check.fix.command, check.fix.args)}`
        : `Failed to run ${formatCommand(check.fix.command, check.fix.args)}`,
    });
  }

  const rerun = await collectDoctorReport(context);
  return {
    ...rerun,
    fixes,
  };
}

function checkNodeVersion({ nodeVersion }) {
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0] ?? '0', 10);
  if (Number.isFinite(major) && major >= 22) {
    return {
      id: 'node',
      label: 'Node.js',
      status: 'ok',
      summary: `Detected ${nodeVersion}`,
    };
  }

  return {
    id: 'node',
    label: 'Node.js',
    status: 'error',
    summary: `Detected ${nodeVersion || 'unknown version'}`,
    suggestion: 'Install Node.js 22 or newer before running web-agent-console.',
  };
}

async function checkCodex({ env, cwd, commandRunner }) {
  const codexBin = env.CODEX_BIN ?? 'codex';
  const result = await commandRunner(codexBin, ['--version'], { cwd, env });
  if (result.ok) {
    return {
      id: 'codex',
      label: 'Codex CLI',
      status: 'ok',
      summary: firstOutputLine(result) ?? `Detected ${codexBin}`,
    };
  }

  return {
    id: 'codex',
    label: 'Codex CLI',
    status: 'error',
    summary: `Could not run ${codexBin}`,
    suggestion: 'Install Codex, make sure it is on PATH, or set CODEX_BIN to the executable path.',
  };
}

function checkClaudeSdkPackage({ packageResolver }) {
  try {
    packageResolver('@anthropic-ai/claude-agent-sdk');
    return {
      id: 'claude-sdk-package',
      label: 'Claude Agent SDK package',
      status: 'ok',
      summary: 'Resolved @anthropic-ai/claude-agent-sdk',
    };
  } catch {
    return {
      id: 'claude-sdk-package',
      label: 'Claude Agent SDK package',
      status: 'error',
      summary: 'Could not resolve @anthropic-ai/claude-agent-sdk',
      suggestion: 'Install project dependencies with `npm install` before using the claude-sdk provider.',
    };
  }
}

async function checkClaudeCodeCli({ cwd, env, commandRunner }) {
  const result = await commandRunner('claude', ['--version'], { cwd, env });
  if (result.ok) {
    return {
      id: 'claude-code-cli',
      label: 'Claude Code CLI',
      status: 'ok',
      summary: firstOutputLine(result) ?? 'Detected claude',
    };
  }

  return {
    id: 'claude-code-cli',
    label: 'Claude Code CLI',
    status: 'error',
    summary: 'Could not run claude',
    suggestion: 'Install Claude Code so the claude-sdk provider can rely on the local Claude environment.',
    fix: {
      command: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code'],
    },
  };
}

function checkClaudeAuth({ env, homeDir, pathExists }) {
  if (normalizeEnvValue(env.ANTHROPIC_API_KEY)) {
    return {
      id: 'claude-auth',
      label: 'Claude authentication',
      status: 'ok',
      summary: 'Detected ANTHROPIC_API_KEY',
    };
  }

  if (homeDir && pathExists(join(homeDir, '.claude'))) {
    return {
      id: 'claude-auth',
      label: 'Claude authentication',
      status: 'warning',
      summary: 'Found ~/.claude, but doctor cannot confirm the active Claude login non-interactively.',
      suggestion: 'If claude-sdk requests fail, run `claude` and complete `/login` to refresh the local Claude Code login state.',
    };
  }

  return {
    id: 'claude-auth',
    label: 'Claude authentication',
    status: 'error',
    summary: 'No Claude authentication signal was found.',
    suggestion: 'Run `claude` and complete `/login`, or set `ANTHROPIC_API_KEY` before using the claude-sdk provider.',
  };
}

function defaultPackageResolver(specifier) {
  return require.resolve(specifier);
}

function defaultCommandRunner(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return {
    ok: result.status === 0 && !result.error,
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function firstOutputLine(result) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return combined ?? null;
}

function formatCommand(command, args = []) {
  return [command, ...args].join(' ');
}

function normalizeEnvValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function statusIcon(status) {
  if (status === 'ok') {
    return 'OK';
  }
  if (status === 'warning') {
    return '!!';
  }
  if (status === 'fixed') {
    return 'OK';
  }
  if (status === 'failed') {
    return 'XX';
  }
  return 'XX';
}
