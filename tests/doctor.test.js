import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDoctorReport, runDoctor } from '../src/lib/doctor.js';

test('doctor reports missing codex and claude prerequisites with targeted suggestions', async () => {
  const report = await runDoctor({
    cwd: '/tmp/workspace',
    env: {},
    homeDir: '/tmp/home',
    nodeVersion: 'v22.22.0',
    packageResolver: () => '/tmp/workspace/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    pathExists: () => false,
    commandRunner: async (command) => ({
      ok: false,
      error:
        command === 'claude'
          ? new Error('spawn claude ENOENT')
          : new Error(`spawn ${command} ENOENT`),
    }),
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.status]),
    [
      ['node', 'ok'],
      ['codex', 'error'],
      ['claude-sdk-package', 'ok'],
      ['claude-code-cli', 'error'],
      ['claude-auth', 'error'],
    ],
  );
  assert.match(formatDoctorReport(report), /Install Codex/);
  assert.match(formatDoctorReport(report), /npm install -g @anthropic-ai\/claude-code/);
  assert.match(formatDoctorReport(report), /Run `claude` and complete `\/login`/);
});

test('doctor --fix only applies safe automatic fixes and reruns checks', async () => {
  let claudeInstalled = false;
  const commands = [];
  const report = await runDoctor({
    cwd: '/tmp/workspace',
    env: {
      ANTHROPIC_API_KEY: 'test-key',
    },
    homeDir: '/tmp/home',
    nodeVersion: 'v22.22.0',
    packageResolver: () => '/tmp/workspace/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    pathExists: () => false,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);

      if (command === 'claude' && args[0] === '--version') {
        return claudeInstalled
          ? { ok: true, stdout: 'claude 2.1.86\n' }
          : { ok: false, error: new Error('spawn claude ENOENT') };
      }

      if (command === 'codex' && args[0] === '--version') {
        return { ok: false, error: new Error('spawn codex ENOENT') };
      }

      if (command === 'npm' && args.join(' ') === 'install -g @anthropic-ai/claude-code') {
        claudeInstalled = true;
        return { ok: true, stdout: 'installed\n' };
      }

      return { ok: true, stdout: '' };
    },
    fix: true,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.fixes.map((fix) => [fix.id, fix.status]),
    [['claude-code-cli', 'fixed']],
  );
  assert.deepEqual(
    commands,
    [
      ['codex', '--version'],
      ['claude', '--version'],
      ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
      ['codex', '--version'],
      ['claude', '--version'],
    ],
  );
  assert.equal(
    report.checks.find((check) => check.id === 'claude-code-cli')?.status,
    'ok',
  );
});
