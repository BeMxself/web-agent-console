import test from 'node:test';
import assert from 'node:assert/strict';

import { syncApprovalModeControls } from '../../public/app/render-shell.js';

test('syncApprovalModeControls treats browser-normalized boolean attributes as unchanged markup', () => {
  let serializedHtml = '';
  const node = {
    hidden: false,
  };

  Object.defineProperty(node, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get() {
      return serializedHtml;
    },
    set(value) {
      serializedHtml = String(value).replace(/\shidden(?=[ >])/g, ' hidden=""');
    },
  });

  const markup =
    '<div class="composer-settings-mobile-shell">' +
    '<div class="composer-settings-mobile-summary-row"></div>' +
    '<div class="composer-settings-mobile-panel" hidden></div>' +
    '</div>';

  assert.equal(syncApprovalModeControls(node, markup, false), true);
  assert.equal(syncApprovalModeControls(node, markup, false), false);
});
