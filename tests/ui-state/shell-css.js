import {
  test,
  assert,
  reduceState,
  renderProjectSidebar,
  renderHistoryDialog,
  readPublicFile,
} from './shared.js';

test('shell html removes the generic conversation title and renames panel controls', () => {
  const html = readPublicFile('index.html');

  assert.match(
    html,
    /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" \/>/,
  );
  assert.match(html, /<span class="panel-toggle-label">项目\/会话<\/span>/);
  assert.match(html, /<span class="panel-toggle-label">活动\/任务<\/span>/);
  assert.match(html, /class="panel-toggle-mobile-glyph" aria-hidden="true">/);
  assert.match(html, /class="panel-toggle-mobile-bar"/);
  assert.match(html, /id="conversation-status"/);
  assert.match(html, /class="conversation-status conversation-status--connected"/);
  assert.match(html, /class="conversation-status-label">在线<\/span>/);
  assert.match(
    html,
    /<div class="conversation-header-title">\s*<div id="conversation-title" class="conversation-title" hidden><\/div>\s*<\/div>\s*<div id="conversation-status" class="conversation-status conversation-status--connected" role="status" aria-live="polite">[\s\S]*?<\/div>\s*<button[\s\S]*?id="activity-panel-toggle"/,
  );
  assert.match(html, /class="session-dock"/);
  assert.match(html, /id="session-dock-plan-summary"/);
  assert.match(html, /class="composer-action-row"/);
  assert.match(html, /class="composer-footer"/);
  assert.match(html, /data-composer-attach-trigger="true"/);
  assert.match(html, /id="composer-inline-feedback"/);
  assert.match(html, /<textarea id="composer-input" rows="1" placeholder="输入下一步请求"><\/textarea>/);
  assert.match(html, /class="sr-only">显示导航跳转按钮</);
  assert.match(html, /class="composer-nav-toggle-icon" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, />显示回合跳转按钮</);
  assert.match(html, /aria-label="调整项目\/会话宽度"/);
  assert.match(html, /aria-label="调整活动宽度"/);
  assert.match(html, /id="activity-panel-toggle"[\s\S]*aria-expanded="false"/);
  assert.doesNotMatch(html, />会话视图</);
  assert.doesNotMatch(html, /id="logout-button"/);
  assert.match(html, /id="auth-theme-toggle"/);
  assert.match(html, /data-theme-toggle="true"/);
  assert.match(html, /<\/main>\s*<div id="auth-gate" class="auth-gate" hidden>/);
});

test('sidebar and mobile drawer render a fixed logout action in the sessions panel', () => {
  const state = reduceState(undefined, {
    type: 'projects_loaded',
    payload: {
      projects: [
        {
          id: '/tmp/workspace-a',
          cwd: '/tmp/workspace-a',
          displayName: 'workspace-a',
          collapsed: false,
          focusedSessions: [{ id: 'thread-1', name: 'Focus thread' }],
          historySessions: { active: [], archived: [] },
        },
      ],
    },
  });

  const sidebarHtml = renderProjectSidebar({
    ...state,
    auth: {
      required: true,
      authenticated: true,
      checking: false,
      pending: false,
      error: null,
    },
  });
  const activityDrawerHtml = renderHistoryDialog({
    ...state,
    historyDialogProjectId: '/tmp/workspace-a',
  });

  assert.match(sidebarHtml, /退出登录/);
  assert.match(sidebarHtml, /data-logout-button="true"/);
  assert.match(sidebarHtml, /data-theme-toggle="true"/);
  assert.match(sidebarHtml, /sidebar-footer-actions/);
  assert.match(sidebarHtml, /aria-label="切换到暗色主题"/);
  assert.match(sidebarHtml, /sidebar-footer/);
  assert.match(activityDrawerHtml, /history-dialog/);
});

test('conversation css clamps horizontal overflow in the main thread viewport', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /\.panel-scroll-body\s*\{[^}]*overflow-x:\s*hidden;/s);
  assert.match(css, /\.thread-view\s*\{[^}]*min-width:\s*0;/s);
  assert.doesNotMatch(css, /\.message-markdown pre\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.doesNotMatch(css, /\.message-markdown table\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.doesNotMatch(css, /\.diff-view\s*\{[^}]*overflow:\s*auto;/s);
});

test('conversation status css renders a glowing header light with compact text in the top-right corner', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.conversation-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto auto;[^}]*grid-template-areas:\s*"project title status activity";/s,
  );
  assert.match(css, /\.conversation-status\s*\{[^}]*grid-area:\s*status;[^}]*justify-self:\s*end;/s);
  assert.match(
    css,
    /\.conversation-status-light\s*\{[^}]*width:\s*(12|13|14)px;[^}]*height:\s*(12|13|14)px;[^}]*box-shadow:\s*0 0 0 [^;]+,\s*0 0 [^;]+;/s,
  );
  assert.match(
    css,
    /\.conversation-status--connected\s+\.conversation-status-light\s*\{[^}]*background:\s*#2b7d48;[^}]*box-shadow:\s*0 0 0 [^;]+,\s*0 0 [^;]+;/s,
  );
  assert.match(
    css,
    /@media \(max-width:\s*760px\)\s*\{[\s\S]*\.conversation-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);[^}]*grid-template-areas:\s*"project status"\s*"title title";/s,
  );
});

test('auth css uses a fullscreen high-blur overlay while the login gate is visible', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.auth-gate\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*pointer-events:\s*auto;[^}]*backdrop-filter:\s*blur\((3[2-9]|[4-9]\d)px\)/s,
  );
  assert.match(css, /\.auth-gate\s*\{[^}]*z-index:\s*40;/s);
  assert.match(css, /\.auth-gate\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
});

test('layout css pins panels to fixed grid tracks when sidebars collapse', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /#session-list\s*\{[^}]*grid-column:\s*1;/s);
  assert.match(css, /#project-panel-resizer\s*\{[^}]*grid-column:\s*2;/s);
  assert.match(css, /#conversation-panel\s*\{[^}]*grid-column:\s*3;/s);
  assert.match(css, /#activity-panel-resizer\s*\{[^}]*grid-column:\s*4;/s);
  assert.match(css, /#activity-panel\s*\{[^}]*grid-column:\s*5;/s);
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#session-list,\s*#project-panel-resizer,\s*#conversation-panel,\s*#activity-panel-resizer,\s*#activity-panel\s*\{[^}]*grid-column:\s*1;/s,
  );
});

test('mobile layout css keeps the conversation pinned to the viewport with a fixed bottom composer', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*body\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.layout\s*\{[^}]*height:\s*100dvh;[^}]*min-height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#conversation-panel\s*\{[^}]*padding:\s*max\(12px,\s*env\(safe-area-inset-top\)\)\s*12px\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#composer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;[^}]*background:\s*linear-gradient\(180deg,\s*rgba\(248,\s*250,\s*252,\s*0\.72\),\s*rgba\(244,\s*247,\s*250,\s*0\.88\)\);/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-scroll-body\s*\{[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-scroll-body\s*\{[^}]*padding-right:\s*0;/s,
  );
  assert.doesNotMatch(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-scroll-body\s*\{[^}]*overflow:\s*visible;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#activity-panel-toggle\s*\{[^}]*display:\s*none\s*!important;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.panel-toggle-mobile-glyph\s*\{[^}]*display:\s*inline-flex;/s,
  );
  assert.match(
    css,
    /\.panel-toggle-mobile-glyph\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*4px;/s,
  );
  assert.match(
    css,
    /\.panel-toggle-mobile-bar\s*\{[^}]*width:\s*18px;[^}]*height:\s*2px;[^}]*background:\s*currentColor;/s,
  );
  assert.match(
    css,
    /\.mobile-project-sidebar\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*100%;/s,
  );
  assert.match(
    css,
    /\.mobile-project-sidebar\s+\.sidebar-footer\s*\{[^}]*margin-top:\s*auto;[^}]*position:\s*static;/s,
  );
  assert.match(css, /\.mobile-drawer-close\s*\{[^}]*border-radius:\s*999px;/s);
});

test('mobile composer css collapses settings into a summary strip and keeps the action row compact', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*#composer-input\s*\{[^}]*min-height:\s*(5[0-9]|6[0-9])px;[^}]*max-height:\s*(14[0-9]|15[0-9])px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.composer-action-row\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*flex-end;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.composer-footer\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*flex-start;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-shell\s*\{[^}]*display:\s*grid;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-summary\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-summary-icon\s*\{[^}]*display:\s*inline-flex;[^}]*width:\s*(14|15|16)px;[^}]*height:\s*(14|15|16)px;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-panel\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s,
  );
  assert.match(
    css,
    /\.composer-settings-mobile-confirm\s*\{[^}]*min-height:\s*(34|35|36)px;[^}]*border-radius:\s*(10|11|12)px;/s,
  );
});

test('mobile conversation css keeps turn cards, plan steps, and message bubbles compact', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-nav\s*\{[^}]*margin-top:\s*(6|7|8)px;[^}]*padding:\s*(6|7|8)px\s+0\s+(1|2|3)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-nav-button\s*\{[^}]*padding:\s*(5|6|7)px\s+(8|9|10)px;[^}]*font-size:\s*11px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.turn-card-header\s*\{[^}]*margin-bottom:\s*(5|6|7|8)px;[^}]*font-size:\s*11px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-item-card\s*\{[^}]*padding:\s*(8|9)px\s+(10|11)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.thread-item-card\s*\{[^}]*margin-bottom:\s*(5|6|7)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.task-plan-step\s*\{[^}]*padding:\s*(8|9|10)px\s+(9|10|11)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.message-bubble\s*\{[^}]*padding:\s*(8|9|10)px\s+(10|11|12)px;/s,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)\s*\{[\s\S]*\.message-bubble\s*\{[^}]*margin-bottom:\s*(6|7|8)px;/s,
  );
});

test('sidebar css keeps session rows compact and close buttons centered', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /\.focused-session-row\s*\{[^}]*overflow:\s*visible;[^}]*border-radius:\s*8px;/s);
  assert.match(css, /\.session-item,\s*\.focus-remove,\s*#composer button\s*\{[^}]*border-radius:\s*8px;/s);
  assert.match(
    css,
    /\.project-close\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1;/s,
  );
  assert.match(
    css,
    /\.focus-remove--embedded\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1;/s,
  );
  assert.match(
    css,
    /\.history-dialog-close\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*padding:\s*0;/s,
  );
  assert.match(css, /\.sidebar-footer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);
  assert.match(css, /\.sidebar-footer-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*(8|9|10)px;/s);
  assert.match(css, /\.sidebar-logout-button\s*\{[^}]*flex:\s*1\s+1\s+auto;/s);
  assert.match(
    css,
    /\.sidebar-theme-toggle\s*\{[^}]*width:\s*(42|44)px;[^}]*min-width:\s*(42|44)px;[^}]*min-height:\s*(42|44)px;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
  );
  assert.match(
    css,
    /\.session-status-indicator--unread\s*\{[^}]*background:\s*#2f7ec1;[^}]*box-shadow:\s*0 0 0 4px rgba\(47,\s*126,\s*193,\s*0\.14\);/s,
  );
  assert.match(
    css,
    /\.session-item--focused\[aria-current="true"\]\s+\.session-status-indicator--unread\s*\{[^}]*background:\s*#2f7ec1;[^}]*box-shadow:\s*0 0 0 4px rgba\(47,\s*126,\s*193,\s*0\.16\);/s,
  );
  assert.match(css, /\.history-item-title-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;/s);
});

test('theme css adds a dark palette and transparent icon toggle affordance', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /body\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;[^}]*background:[^}]*linear-gradient/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.panel\s*\{[^}]*background:\s*rgba\([^)]*\);[^}]*box-shadow:\s*0 18px 60px rgba\(/s,
  );
  assert.match(
    css,
    /\.sidebar-theme-toggle:hover\s*\{[^}]*background:\s*rgba\([^)]*\);/s,
  );
  assert.match(
    css,
    /\.sidebar-theme-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid rgba\(/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.project-toggle\s*\{[^}]*color:\s*#e6eef8;/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.panel-toggle\s*\{[^}]*background:\s*rgba\([^)]*\);[^}]*color:\s*#dce7f2;/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.sidebar-logout-button\s*\{[^}]*background:\s*rgba\([^)]*\);[^}]*color:\s*#ffd7d2;/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.project-action[\s\S]*background:\s*rgba\([^)]*\);[^}]*color:\s*#dce7f2;/s,
  );
  assert.match(
    css,
    /body\[data-theme="dark"\]\s+\.history-dialog-frame\s+\.session-item\s*\{[^}]*background:\s*rgba\([^)]*\);[^}]*color:\s*#dce7f2;/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+\.composer-nav-toggle\s*\{[^}]*background:\s*rgba\([^)]*\);[^}]*color:\s*#dce7f2;/s,
  );
  assert.match(
    css,
    /\.layout\[data-theme="dark"\]\s+#conversation-panel\s*\{[^}]*background:\s*linear-gradient/s,
  );
  assert.match(
    css,
    /body\[data-theme="dark"\]\s+\.mobile-drawer-shell\s*\{[^}]*background:\s*linear-gradient/s,
  );
  assert.match(
    css,
    /body\[data-theme="dark"\]\s+\.auth-theme-toggle\s*\{[^}]*color:\s*#dce7f2;/s,
  );
});

test('sidebar and conversation css keep emphasis lightweight', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.session-item--focused\[aria-current="true"\]\s*\{[^}]*color:\s*#112031;[^}]*box-shadow:\s*0 10px 24px rgba\(17, 32, 49, 0\.08\);/s,
  );
  assert.doesNotMatch(
    css,
    /\.session-item--focused\[aria-current="true"\]\s*\{[^}]*linear-gradient\(135deg,\s*#112031,\s*#20394e\);/s,
  );
  assert.match(
    css,
    /\.project-action--primary\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.96\);[^}]*color:\s*#3e5f80;/s,
  );
  assert.doesNotMatch(css, /\.project-action--primary\s*\{[^}]*linear-gradient/s);
  assert.match(
    css,
    /#send-button\[data-action="interrupt"\]\s*\{[^}]*background:\s*linear-gradient\(180deg,\s*#d98a2b,\s*#b66a16\);/s,
  );
  assert.match(
    css,
    /\.turn-card\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-top:\s*1px solid rgba\(17, 32, 49, 0\.08\);/s,
  );
  assert.match(
    css,
    /\.thread-item-card\s*\{[^}]*padding:\s*10px 12px;[^}]*border-radius:\s*14px;[^}]*border:\s*1px solid rgba\(17, 32, 49, 0\.06\);[^}]*background:\s*rgba\(255, 255, 255, 0\.76\);/s,
  );
});

test('composer control css keeps session selectors compact, uses an icon nav toggle, and hides the secondary interrupt button', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /\.composer-toolbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
  );
  assert.match(
    css,
    /\.approval-mode-shell\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    css,
    /\.approval-mode-select\s*\{[^}]*min-height:\s*32px;[^}]*font-size:\s*11px;/s,
  );
  assert.match(
    css,
    /\.composer-toolbar-secondary\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*flex-end;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    css,
    /\.composer-nav-toggle\s*\{[^}]*width:\s*34px;[^}]*height:\s*32px;[^}]*border-radius:\s*999px;/s,
  );
  assert.match(
    css,
    /\.composer-nav-toggle input\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*opacity:\s*0;/s,
  );
  assert.match(
    css,
    /\.composer-nav-toggle-icon\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s,
  );
  assert.match(
    css,
    /#interrupt-button\s*\{[^}]*display:\s*none;/s,
  );
});

test('desktop composer css keeps controls on a compact single row when space allows', () => {
  const css = readPublicFile('app.css');

  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.composer-toolbar\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*center;[^}]*justify-content:\s*flex-end;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*margin-left:\s*auto;/s,
  );
  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.approval-mode-controls-slot\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 1 auto;/s,
  );
  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.composer-toolbar-secondary\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 1 auto;[^}]*justify-content:\s*flex-end;/s,
  );
  assert.match(
    css,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*\.approval-mode-group\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*120px;/s,
  );
});

test('thread item card css separates status chips from disclosure toggles and styles file changes compactly', () => {
  const css = readPublicFile('app.css');

  assert.match(css, /\.thread-item-card-summary-meta\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*8px;/s);
  assert.match(css, /\.thread-item-card-status--failed\s*\{[^}]*background:[^}]*rgba\(176,\s*55,\s*55,\s*0\.12\)/s);
  assert.match(css, /\.thread-item-card-toggle\s*\{[^}]*border:\s*1px solid rgba\(17,\s*32,\s*49,\s*0\.08\);/s);
  assert.match(css, /\.thread-item-card-toggle-label\s*\{[^}]*font-size:\s*11px;/s);
  assert.match(css, /\.thread-item-card--fileChange\s*\{[^}]*background:\s*rgba\(244,\s*242,\s*255,\s*0\.76\);/s);
});
