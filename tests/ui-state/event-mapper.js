import { test, assert, mapCodexNotification } from './shared.js';

test('codex mapper normalizes thread realtime notifications', () => {
  assert.deepEqual(
    mapCodexNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      },
    }),
    {
      type: 'turn_started',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'completed', items: [] },
      },
    }),
    {
      type: 'turn_completed',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'completed', items: [] },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/started',
      params: { threadId: 'thread-1', sessionId: 'rt-session-1' },
    }),
    {
      type: 'thread_realtime_started',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', sessionId: 'rt-session-1' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/itemAdded',
      params: {
        threadId: 'thread-1',
        item: { type: 'response.created', response: { id: 'resp-1' } },
      },
    }),
    {
      type: 'thread_realtime_item_added',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        item: { type: 'response.created', response: { id: 'resp-1' } },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/outputAudio/delta',
      params: {
        threadId: 'thread-1',
        audio: {
          data: 'AAA=',
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 480,
        },
      },
    }),
    {
      type: 'thread_realtime_audio_delta',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        audio: {
          data: 'AAA=',
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 480,
        },
      },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/error',
      params: { threadId: 'thread-1', message: 'stream failed' },
    }),
    {
      type: 'thread_realtime_error',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', message: 'stream failed' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/realtime/closed',
      params: { threadId: 'thread-1', reason: 'completed' },
    }),
    {
      type: 'thread_realtime_closed',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', reason: 'completed' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'thread/name/updated',
      params: { threadId: 'thread-1', name: 'Renamed session' },
    }),
    {
      type: 'thread_name_updated',
      threadId: 'thread-1',
      payload: { threadId: 'thread-1', name: 'Renamed session' },
    },
  );

  assert.deepEqual(
    mapCodexNotification({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        explanation: '先补协议再补 UI',
        plan: [
          { step: '对接结构化任务事件', status: 'completed' },
          { step: '右栏拆成活动和任务', status: 'inProgress' },
        ],
      },
    }),
    {
      type: 'turn_plan_updated',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        explanation: '先补协议再补 UI',
        plan: [
          { step: '对接结构化任务事件', status: 'completed' },
          { step: '右栏拆成活动和任务', status: 'inProgress' },
        ],
      },
    },
  );
});
