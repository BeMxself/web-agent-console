import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAppController,
  findConversationTurnTarget,
  reduceState,
  renderProjectSidebar,
  renderHistoryDialog,
  renderThreadDetail,
} from '../../public/app.js';
import { mapCodexNotification } from '../../src/lib/codex-event-mapper.js';
import {
  setupUiTestEnvironment,
  readPublicFile,
  createFakeEventSource,
  assertTaskSummaryItem,
  assertComposerSetting,
  jsonResponse,
  jsonErrorResponse,
  createFakeDocument,
  createFakeStorage,
  createDeferred,
  createFakeFile,
  createClipboardImageItem,
  trackInnerHtmlWrites,
} from '../helpers/ui-test-helpers.js';

setupUiTestEnvironment();

export {
  test,
  assert,
  createAppController,
  findConversationTurnTarget,
  reduceState,
  renderProjectSidebar,
  renderHistoryDialog,
  renderThreadDetail,
  mapCodexNotification,
  readPublicFile,
  createFakeEventSource,
  assertTaskSummaryItem,
  assertComposerSetting,
  jsonResponse,
  jsonErrorResponse,
  createFakeDocument,
  createFakeStorage,
  createDeferred,
  createFakeFile,
  createClipboardImageItem,
  trackInnerHtmlWrites,
};
