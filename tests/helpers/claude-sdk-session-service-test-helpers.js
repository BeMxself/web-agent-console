import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkSessionIndex } from '../../src/lib/claude-sdk-session-index.js';
import { ClaudeSdkSessionService } from '../../src/lib/claude-sdk-session-service.js';
import { SessionService } from '../../src/lib/session-service.js';
import { RuntimeStore } from '../../src/lib/runtime-store.js';
import { createFakeClaudeSdk } from './fake-claude-sdk.js';


export {
  test,
  assert,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  tmpdir,
  join,
  ClaudeSdkSessionIndex,
  ClaudeSdkSessionService,
  SessionService,
  RuntimeStore,
  createFakeClaudeSdk,
};

export function createMemoryActivityStore(initialSnapshot = { projects: {} }) {
  const snapshot = {
    projects: structuredClone(initialSnapshot.projects ?? {}),
  };

  return {
    async load() {
      return snapshot;
    },
    async addProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = false;
      return snapshot.projects[projectId];
    },
    async addFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      if (!snapshot.projects[projectId].focusedThreadIds.includes(threadId)) {
        snapshot.projects[projectId].focusedThreadIds.push(threadId);
      }
      snapshot.projects[projectId].hidden = false;
      return snapshot.projects[projectId];
    },
    async removeFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].focusedThreadIds = snapshot.projects[projectId].focusedThreadIds.filter(
        (candidate) => candidate !== threadId,
      );
      return snapshot.projects[projectId];
    },
    async setCollapsed(projectId, collapsed) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].collapsed = Boolean(collapsed);
      return snapshot.projects[projectId];
    },
    async hideProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId].hidden = true;
      snapshot.projects[projectId].focusedThreadIds = [];
      return snapshot.projects[projectId];
    },
  };
}

export function createSnapshottingActivityStore(initialSnapshot = { projects: {} }) {
  let snapshot = {
    projects: structuredClone(initialSnapshot.projects ?? {}),
  };

  return {
    async load() {
      return structuredClone(snapshot);
    },
    async addProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        hidden: false,
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async addFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      const focusedThreadIds = snapshot.projects[projectId].focusedThreadIds.includes(threadId)
        ? snapshot.projects[projectId].focusedThreadIds
        : [...snapshot.projects[projectId].focusedThreadIds, threadId];
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        focusedThreadIds,
        hidden: false,
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async removeFocusedSession(projectId, threadId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        focusedThreadIds: snapshot.projects[projectId].focusedThreadIds.filter(
          (candidate) => candidate !== threadId,
        ),
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async setCollapsed(projectId, collapsed) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        collapsed: Boolean(collapsed),
      };
      return structuredClone(snapshot.projects[projectId]);
    },
    async hideProject(projectId) {
      snapshot.projects[projectId] ??= {
        collapsed: false,
        focusedThreadIds: [],
        hidden: false,
      };
      snapshot.projects[projectId] = {
        ...snapshot.projects[projectId],
        hidden: true,
        focusedThreadIds: [],
      };
      return structuredClone(snapshot.projects[projectId]);
    },
  };
}

export function createSuccessResultMessage({ sessionId, uuid, result }) {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: sessionId,
  };
}

export function createErrorResultMessage({ sessionId, uuid, errors }) {
  return {
    ...createSuccessResultMessage({
      sessionId,
      uuid,
      result: null,
    }),
    is_error: true,
    subtype: 'error',
    errors,
  };
}

export function createAssistantToolUseMessage({ uuid, toolUseId, toolName, input }) {
  return {
    type: 'assistant',
    uuid,
    message: {
      id: uuid,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input,
        },
      ],
    },
  };
}

export async function readFirstPromptMessage(prompt) {
  const iterator = prompt?.[Symbol.asyncIterator]?.();
  if (!iterator || typeof iterator.next !== 'function') {
    throw new Error('prompt is not an async iterable');
  }

  const first = await iterator.next();
  if (!first || first.done) {
    throw new Error('prompt async iterable yielded no messages');
  }

  return first.value;
}

export async function waitForCondition(predicate, { timeoutMs = 500 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('condition was not met before the timeout elapsed');
}

export async function waitForAbort(abortController) {
  if (!abortController) {
    await new Promise(() => {});
    return;
  }

  if (abortController.signal.aborted) {
    throw createAbortError();
  }

  await new Promise((resolve, reject) => {
    abortController.signal.addEventListener(
      'abort',
      () => reject(createAbortError()),
      { once: true },
    );
  });
}

export function createAbortError() {
  const error = new Error('Query aborted');
  error.name = 'AbortError';
  return error;
}

export function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}
