import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shouldAutoBootstrapDocument } from '../../public/app.js';

test('app bootstrap only runs for documents that opt in explicitly', () => {
  assert.equal(
    shouldAutoBootstrapDocument({
      body: {
        dataset: {
          webAgentBootstrap: 'true',
        },
      },
      documentElement: { dataset: {} },
    }),
    true,
  );

  assert.equal(
    shouldAutoBootstrapDocument({
      body: {
        dataset: {},
      },
      documentElement: { dataset: {} },
    }),
    false,
  );

  assert.equal(
    shouldAutoBootstrapDocument({
      body: {
        dataset: {},
      },
      documentElement: {
        dataset: {
          webAgentBootstrap: 'true',
        },
      },
    }),
    true,
  );
});

test('readme mock page provides an inline favicon for static preview renders', () => {
  const html = readFileSync(
    new URL('../../docs/readme/mobile-mock-scenes.html', import.meta.url),
    'utf8',
  );

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
});

test('readme sessions mock keeps the mobile drawer pinned over the phone viewport', () => {
  const html = readFileSync(
    new URL('../../docs/readme/mobile-mock-scenes.html', import.meta.url),
    'utf8',
  );

  assert.match(html, /\.screenshot-phone \.mobile-drawer-frame \{\s*position:\s*absolute;/);
  assert.match(html, /\.screenshot-phone \.mobile-drawer-frame \{[\s\S]*inset:\s*0;/);
});
