# Project Dialog History And Directory Browser Design

## Context

The add-project dialog currently only contains a freeform `cwd` input and submit button in [public/index.html](/Users/songmingxu/Projects/web-agent-console/public/index.html). The app already has two related capabilities elsewhere:

- project history grouped by `cwd` in the loaded `projects` collection
- a local directory browser backed by `/api/local-files/list` and rendered in the activity panel

The requested change should extend the existing add-project flow instead of creating a second path-selection system. The canonical submit path remains `createProject(cwd)` in [public/app/controller-runtime-api.js](/Users/songmingxu/Projects/web-agent-console/public/app/controller-runtime-api.js).

## Goals

- Add a tabbed selection area below the add-project input.
- Provide two panels:
  - previously opened projects
  - a local directory tree starting at `HOME`
- Keep the input as the single source of truth for the selected `cwd`.
- Preserve the existing project-open action and backend contract.
- Remove redundant dialog chrome to make room for the new content.
- Keep the mobile experience usable without double scrollbars, collapsed content, or off-screen overflow.

## Non-Goals

- No new backend API for creating projects.
- No second submit path separate from `createProject(cwd)`.
- No automatic project opening when the user taps a history item or directory row.
- No reuse of the activity-panel file browser state directly, because that state is scoped to an already selected session.

## Existing Canonical Paths

### Project creation

- Dialog markup: [public/index.html](/Users/songmingxu/Projects/web-agent-console/public/index.html)
- Dialog event binding: [public/app/controller-dom.js](/Users/songmingxu/Projects/web-agent-console/public/app/controller-dom.js)
- Submit action: [public/app/controller-runtime-api.js](/Users/songmingxu/Projects/web-agent-console/public/app/controller-runtime-api.js)

### Local directory listing

- Local directory list URL builder: [public/app/file-preview-utils.js](/Users/songmingxu/Projects/web-agent-console/public/app/file-preview-utils.js)
- Fetching and state transitions: [public/app/controller-session-api.js](/Users/songmingxu/Projects/web-agent-console/public/app/controller-session-api.js), [public/app/state.js](/Users/songmingxu/Projects/web-agent-console/public/app/state.js)
- Existing rendering patterns for entries and parent navigation: [public/app/render-activity.js](/Users/songmingxu/Projects/web-agent-console/public/app/render-activity.js)

### History data source

- Loaded projects already represent known project `cwd` values, including projects discovered from historical sessions.
- The add-project history list should be derived from `state.projects`, not from a new API.

## Proposed UX

### Header and actions

- Keep the eyebrow text `添加项目`.
- Remove the large title text `把工作区加入左侧项目树`.
- Keep the close button.
- Remove the cancel button.
- Change the primary submit control to an icon button.
- Place the input and submit button on the same row.
- Match the submit button height to the input height.

### Tab area

Add a new content area under the input row with two tabs:

- `历史项目`
- `目录树`

The tab content occupies the remaining dialog height.

### History panel behavior

- Show one row per known project `cwd`.
- Use project display name plus full path where helpful.
- Clicking a history row updates the input value to that `cwd`.
- Clicking a history row does not submit automatically.
- The selected history row should visually follow the current input value when it exactly matches a known project path.

### Directory tree behavior

- Initial root is the user's `HOME` directory.
- Opening the dialog initializes both the directory panel current path and the input value to `HOME`.
- The panel shows:
  - current path summary
  - optional parent navigation row
  - current directory entries
- Clicking a directory row does two things in one interaction:
  - updates the input value to the clicked directory path
  - navigates into that directory
- Clicking the parent row does two things in one interaction:
  - navigates to the parent directory
  - updates the input value to the parent directory path
- File rows are non-primary in this flow. Since the dialog is for selecting project directories, file rows remain visible only if returned by the listing API, but they do not become the selected `cwd` and should not trigger preview behavior inside this dialog.

## State Model

Add dedicated add-project dialog state rather than reusing the session-scoped file browser state.

Suggested state shape in [public/app/state.js](/Users/songmingxu/Projects/web-agent-console/public/app/state.js):

```js
projectDialog: {
  open: false,
  cwdDraft: '',
  activeTab: 'history',
  homePath: null,
  directoryBrowser: {
    rootPath: null,
    currentPath: null,
    parentPath: null,
    entries: [],
    loading: false,
    error: null,
  },
}
```

Key rules:

- `cwdDraft` is the only value submitted to `createProject`.
- History selection updates `cwdDraft` only.
- Directory navigation updates both `cwdDraft` and directory browser state.
- Manual input editing updates `cwdDraft` only and does not implicitly reload the directory browser on every keystroke.

## Controller Changes

Extend the controller with dialog-scoped actions:

- `openProjectDialog()`
- `closeProjectDialog()`
- `setProjectDialogCwdDraft(cwd)`
- `selectProjectDialogTab(tab)`
- `loadProjectDialogDirectory(path)`
- `openProjectDialogDirectoryEntry(path, kind)`
- `openProjectDialogDirectoryParent(path)`

Implementation rules:

- `openProjectDialog()` initializes dialog state and loads `HOME`.
- `closeProjectDialog()` clears dialog-scoped state.
- Directory loading reuses `/api/local-files/list`, but writes into `projectDialog.directoryBrowser`, not `fileBrowser`.
- History rows and directory navigation both call `setProjectDialogCwdDraft(...)`.
- Form submit reads `projectDialog.cwdDraft` first; the DOM input remains a view of that state.

## Rendering Changes

### Markup

The dialog body should become a vertical layout with:

1. header
2. input row
3. tabs
4. tab panel content

Input row:

- text input expands to fill width
- icon submit button sits inline on the right

Tab panel rendering should be driven from application state rather than direct DOM-only mutations so that selection, loading, and navigation remain consistent after rerenders.

### Panel content

History panel:

- simple scrollable list
- empty state when there are no known projects

Directory panel:

- current path summary
- parent navigation button when available
- directory list
- loading and error states

## Mobile And Scrolling Constraints

The dialog must avoid nested scroll containers fighting each other.

Layout rules:

- The dialog frame gets a viewport-capped max height.
- The shell uses `grid-template-rows: auto auto auto minmax(0, 1fr)`.
- The shell itself does not scroll.
- Only the active panel body scrolls.
- All intermediate flex or grid containers must use `min-height: 0` where needed so the content region can actually shrink.

Mobile rules:

- Use a narrow-width responsive layout with the same single submit row.
- Keep touch targets generous.
- Prevent the panel region from collapsing below a usable height.
- Keep the full dialog within the visible viewport.
- Reset the panel scroll position to the top when switching tabs or changing directories.

## Visual Language

The change should preserve the current dialog styling vocabulary:

- same rounded shell
- same typography family and dark-mode patterns
- tab styling consistent with existing history dialog tabs
- list rows visually aligned with the app's current interactive surfaces

This is an extension of the existing design system, not a redesign.

## Testing Strategy

Add or update UI-state tests to cover:

- opening the project dialog initializes `HOME`
- history tab rows update the draft input
- directory entry navigation updates both draft input and current directory
- parent navigation updates both draft input and current directory
- manual input edits do not break subsequent submit
- submit still posts to `/api/projects` with the selected `cwd`
- mobile rendering or layout-related shell CSS snapshots where existing tests already cover dialog structure

Manual verification should cover:

- desktop dialog sizing
- mobile dialog sizing
- no double scrollbars
- no off-screen overflow
- consistent input synchronization across tabs

## Risks And Mitigations

- Risk: reusing session-scoped file browser state would couple project selection to selected-session state.
  - Mitigation: introduce dialog-scoped browser state.
- Risk: direct DOM writes to the input could diverge from app state.
  - Mitigation: keep `cwdDraft` in state and render the input from it.
- Risk: mobile dialog height regressions.
  - Mitigation: reuse the existing fixed-height dialog pattern already used for the history dialog and keep scrolling isolated to the panel body.

## Implementation Boundary

Implementation should happen in a dedicated git worktree after this design is reviewed and approved. The code change should stay within the existing architecture and keep `createProject(cwd)` as the only project-open path.
