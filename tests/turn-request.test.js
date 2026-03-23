import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTurnRequest, normalizeTurnRequestInput } from '../src/lib/turn-request.js';

test('normalizeTurnRequestInput preserves legacy turn setting coercion semantics', () => {
  assert.deepEqual(normalizeTurnRequestInput('Inspect repo', {
    model: 42,
    reasoningEffort: 'invalid',
    agentType: 123,
    sandboxMode: 'workspace-write',
  }), {
    text: 'Inspect repo',
    model: '42',
    reasoningEffort: null,
    agentType: '123',
    sandboxMode: 'workspace-write',
    attachments: [],
  });
});

test('normalizeTurnRequestInput keeps strict validation for object request form', () => {
  assert.throws(
    () =>
      normalizeTurnRequestInput({
        text: 'Inspect repo',
        model: 42,
        reasoningEffort: null,
        agentType: 42,
        sandboxMode: 'workspace-write',
        attachments: [],
      }),
    /optional turn setting values must be strings or null/,
  );

  assert.deepEqual(
    normalizeTurnRequest({
      text: 'Inspect repo',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      agentType: 'plan',
      sandboxMode: 'read-only',
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
        },
      ],
    }),
    {
      text: 'Inspect repo',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      agentType: 'plan',
      sandboxMode: 'read-only',
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 3,
          dataBase64: 'Zm9v',
        },
      ],
    },
  );
});
