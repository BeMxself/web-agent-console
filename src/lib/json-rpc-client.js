import { WebSocket } from 'ws';

export class JsonRpcClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.requestHandlers = new Set();
  }

  async connect() {
    if (this.isConnected()) {
      return;
    }

    this.socket = null;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);

      socket.once('open', () => {
        this.socket = socket;
        resolve();
      });

      socket.once('error', (error) => {
        if (this.socket === socket) {
          this.socket = null;
        }
        reject(error);
      });

      socket.once('close', () => {
        if (this.socket === socket) {
          this.socket = null;
        }

        for (const { reject } of this.pending.values()) {
          reject(new Error('WebSocket connection closed'));
        }
        this.pending.clear();
      });

      socket.on('message', async (raw) => {
        const message = JSON.parse(String(raw));
        if (typeof message.id !== 'undefined' && typeof message.method !== 'undefined') {
          const response = { jsonrpc: '2.0', id: message.id };
          try {
            let hasResult = false;
            for (const handler of this.requestHandlers) {
              const result = await handler(message);
              if (typeof result !== 'undefined') {
                response.result = result;
                hasResult = true;
                break;
              }
            }
            if (!hasResult) {
              response.error = {
                code: -32601,
                message: `No request handler registered for ${message.method}`,
              };
            }
          } catch (error) {
            response.error = {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            };
          }
          this.socket?.send(JSON.stringify(response));
          return;
        }

        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message));
            return;
          }
          pending.resolve(message.result);
          return;
        }

        if (typeof message.method === 'undefined') {
          return;
        }

        for (const handler of this.notificationHandlers) {
          handler(message);
        }
      });
    });
  }

  async request(method, params) {
    if (!this.isConnected()) {
      throw new Error('WebSocket is not connected');
    }

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async close() {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = null;

    await new Promise((resolve) => {
      socket.once('close', resolve);
      socket.close();
    });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onRequest(handler) {
    this.requestHandlers.add(handler);
    return () => {
      this.requestHandlers.delete(handler);
    };
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
