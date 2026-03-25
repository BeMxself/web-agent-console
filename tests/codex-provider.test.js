import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexProvider } from '../src/lib/codex-provider.js';

test('codex provider accepts legacy and object turn request call shapes', async () => {
  const calls = [];
  const provider = new CodexProvider({
    appServer: {},
    client: {},
    sessionService: {
      async startTurn(threadId, turnRequest) {
        calls.push(['startTurn', threadId, turnRequest]);
        return { turnId: 'turn-1', status: 'started' };
      },
    },
    initializeParams: {},
  });
  provider.run = async (operation) => operation();

  const legacy = await provider.startTurn('thread-1', 'Legacy call', {
    model: 5678,
    reasoningEffort: 'bad-value',
    agentType: 'plan',
  });
  const objectForm = await provider.startTurn('thread-1', {
    text: 'Object call',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    agentType: 'default',
    attachments: [
      {
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 3,
        dataBase64: 'Zm9v',
      },
    ],
  });

  assert.deepEqual(legacy, { turnId: 'turn-1', status: 'started' });
  assert.deepEqual(objectForm, { turnId: 'turn-1', status: 'started' });
  assert.deepEqual(calls, [
    [
      'startTurn',
      'thread-1',
      {
        text: 'Legacy call',
        model: '5678',
        reasoningEffort: null,
        agentType: 'plan',
        attachments: [],
      },
    ],
    [
      'startTurn',
      'thread-1',
      {
        text: 'Object call',
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        agentType: 'default',
        attachments: [
          {
            name: 'diagram.png',
            mimeType: 'image/png',
            size: 3,
            dataBase64: 'Zm9v',
          },
        ],
      },
    ],
  ]);
});

test('codex provider forwards historical-question branching to the session service', async () => {
  const calls = [];
  const provider = new CodexProvider({
    appServer: {},
    client: {},
    sessionService: {
      async branchFromQuestion(threadId, userMessageId, text) {
        calls.push(['branchFromQuestion', threadId, userMessageId, text]);
        return {
          thread: { id: 'thread-branch' },
          turnId: 'turn-branch',
          status: 'started',
        };
      },
    },
    initializeParams: {},
  });
  provider.run = async (operation) => operation();

  const result = await provider.branchFromQuestion('thread-1', 'user-msg-2', 'Edited question');

  assert.deepEqual(result, {
    thread: { id: 'thread-branch' },
    turnId: 'turn-branch',
    status: 'started',
  });
  assert.deepEqual(calls, [['branchFromQuestion', 'thread-1', 'user-msg-2', 'Edited question']]);
});

test('codex provider forwards in-place rewrite requests when the session service supports them', async () => {
  const calls = [];
  const provider = new CodexProvider({
    appServer: {},
    client: {},
    sessionService: {
      async rewriteInPlaceFromQuestion(threadId, userMessageId, text) {
        calls.push(['rewriteInPlaceFromQuestion', threadId, userMessageId, text]);
        return {
          thread: { id: threadId },
          turnId: 'turn-rewrite',
          status: 'started',
        };
      },
    },
    initializeParams: {},
  });
  provider.run = async (operation) => operation();

  const result = await provider.rewriteInPlaceFromQuestion('thread-1', 'user-msg-2', 'Edited question');

  assert.deepEqual(result, {
    thread: { id: 'thread-1' },
    turnId: 'turn-rewrite',
    status: 'started',
  });
  assert.deepEqual(calls, [['rewriteInPlaceFromQuestion', 'thread-1', 'user-msg-2', 'Edited question']]);
});
