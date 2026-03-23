import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActivityStore } from '../src/lib/activity-store.js';

test('activity store persists focused thread ids and collapse state by project', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-activity-store-'));
  const filePath = join(tempDir, 'activity-store.json');

  try {
    const store = new ActivityStore({ filePath });
    await store.addFocusedSession('/tmp/workspace-a', 'thread-1');
    await store.addFocusedSession('/tmp/workspace-a', 'thread-1');
    await store.addFocusedSession('/tmp/workspace-a', 'thread-2');
    await store.removeFocusedSession('/tmp/workspace-a', 'thread-2');
    await store.setCollapsed('/tmp/workspace-a', true);

    const reloadedStore = new ActivityStore({ filePath });
    const snapshot = await reloadedStore.load();
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));

    assert.deepEqual(snapshot.projects['/tmp/workspace-a'], {
      collapsed: true,
      focusedThreadIds: ['thread-1'],
      hidden: false,
    });
    assert.deepEqual(persisted.projects['/tmp/workspace-a'], {
      collapsed: true,
      focusedThreadIds: ['thread-1'],
      hidden: false,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('activity store persists empty projects for the left project tree', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-activity-store-'));
  const filePath = join(tempDir, 'activity-store.json');

  try {
    const store = new ActivityStore({ filePath });
    await store.addProject('/tmp/workspace-empty');

    const reloadedStore = new ActivityStore({ filePath });
    const snapshot = await reloadedStore.load();
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));

    assert.deepEqual(snapshot.projects['/tmp/workspace-empty'], {
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
    });
    assert.deepEqual(persisted.projects['/tmp/workspace-empty'], {
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('activity store can hide and later reopen a project entry', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-activity-store-'));
  const filePath = join(tempDir, 'activity-store.json');

  try {
    const store = new ActivityStore({ filePath });
    await store.addFocusedSession('/tmp/workspace-a', 'thread-1');
    await store.hideProject('/tmp/workspace-a');

    let reloadedStore = new ActivityStore({ filePath });
    let snapshot = await reloadedStore.load();
    assert.deepEqual(snapshot.projects['/tmp/workspace-a'], {
      collapsed: false,
      focusedThreadIds: [],
      hidden: true,
    });

    await store.addProject('/tmp/workspace-a');

    reloadedStore = new ActivityStore({ filePath });
    snapshot = await reloadedStore.load();
    assert.deepEqual(snapshot.projects['/tmp/workspace-a'], {
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('activity store recovers from a corrupted persistence file', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'web-agent-console-activity-store-'));
  const filePath = join(tempDir, 'activity-store.json');
  const corrupted = '{"version":1,"projects":{"oops":true}}\nthis is not valid json\n';

  try {
    await writeFile(filePath, corrupted, 'utf8');

    const store = new ActivityStore({ filePath });
    const snapshot = await store.load();
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    const backups = (await readdir(tempDir)).filter((name) =>
      name.startsWith('activity-store.json.corrupt-'),
    );

    assert.deepEqual(snapshot, {
      version: 1,
      projects: {},
    });
    assert.deepEqual(persisted, {
      version: 1,
      projects: {},
    });
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(tempDir, backups[0]), 'utf8'), corrupted);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
