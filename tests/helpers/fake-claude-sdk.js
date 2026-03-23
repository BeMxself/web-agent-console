export function createFakeClaudeSdk({
  queryResponses = [],
  queryResponseFactories = [],
  sessionInfoById = {},
  sessionMessagesById = {},
  listSessionsResult = [],
} = {}) {
  const calls = {
    query: [],
    queryClose: [],
    queryAbort: [],
    queryStreamInput: [],
    listSessions: [],
    getSessionInfo: [],
    getSessionMessages: [],
    renameSession: [],
  };

  return {
    calls,
    query({ prompt, options = {} }) {
      calls.query.push({ prompt, options });
      const responseFactory = queryResponseFactories.shift();
      if (responseFactory) {
        return wrapQueryHandle(responseFactory({ prompt, options, calls }), calls);
      }

      const messages = queryResponses.shift() ?? [];
      return wrapQueryHandle({
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            yield message;
          }
        },
      }, calls);
    },
    async listSessions(options = {}) {
      calls.listSessions.push(options);
      return listSessionsResult;
    },
    async getSessionInfo(sessionId, options = {}) {
      calls.getSessionInfo.push({ sessionId, options });
      return sessionInfoById[sessionId];
    },
    async getSessionMessages(sessionId, options = {}) {
      calls.getSessionMessages.push({ sessionId, options });
      return sessionMessagesById[sessionId] ?? [];
    },
    async renameSession(sessionId, title, options = {}) {
      calls.renameSession.push({ sessionId, title, options });
      const existing = sessionInfoById[sessionId] ?? {
        sessionId,
        summary: title,
        lastModified: Date.now(),
      };
      sessionInfoById[sessionId] = {
        ...existing,
        summary: title,
        customTitle: title,
        lastModified: Date.now(),
      };
    },
  };
}

function wrapQueryHandle(handle, calls) {
  if (typeof handle?.close === 'function') {
    const originalClose = handle.close.bind(handle);
    handle.close = async (...args) => {
      calls.queryClose.push(args);
      return await originalClose(...args);
    };
  }

  if (typeof handle?.abort === 'function') {
    const originalAbort = handle.abort.bind(handle);
    handle.abort = (...args) => {
      calls.queryAbort.push(args);
      return originalAbort(...args);
    };
  }

  if (typeof handle?.streamInput === 'function') {
    const originalStreamInput = handle.streamInput.bind(handle);
    handle.streamInput = async (stream, ...args) => {
      const collected = [];
      for await (const message of stream) {
        collected.push(message);
      }
      calls.queryStreamInput.push(collected);
      return await originalStreamInput(createReplayStream(collected), ...args);
    };
  }

  return handle;
}

function createReplayStream(messages) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
}
