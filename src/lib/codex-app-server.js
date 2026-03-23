import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

export class CodexAppServer {
  constructor({ codexBin, codexArgs = [], port, cwd = process.cwd() }) {
    this.codexBin = codexBin;
    this.codexArgs = codexArgs;
    this.port = port;
    this.cwd = cwd;
    this.url = `ws://127.0.0.1:${port}`;
    this.child = null;
  }

  async start() {
    if (this.isManagedProcessRunning()) {
      return;
    }

    const child = spawn(this.codexBin, this.codexArgs, {
      cwd: this.cwd,
      stdio: 'pipe',
    });
    this.child = child;

    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
      }
    });

    await waitForWebSocket(this.url, 2000);
  }

  async stop() {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
  }

  isManagedProcessRunning() {
    return Boolean(this.child && this.child.exitCode == null && this.child.signalCode == null);
  }
}

async function waitForWebSocket(url, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await tryConnect(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for WebSocket at ${url}`);
}

async function tryConnect(url) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);

    socket.once('open', () => {
      socket.close();
      resolve();
    });

    socket.once('error', (error) => {
      reject(error);
    });
  });
}
