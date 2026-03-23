import { loadJsonSnapshotFile, writeJsonSnapshotFile } from './json-file-store.js';

const EMPTY_SNAPSHOT = Object.freeze({
  version: 1,
  projects: {},
});

export class ActivityStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.snapshot = null;
  }

  async load() {
    if (this.snapshot) {
      return this.snapshot;
    }

    this.snapshot = await loadJsonSnapshotFile({
      filePath: this.filePath,
      emptySnapshot: EMPTY_SNAPSHOT,
      normalizeSnapshot,
    });
    return this.snapshot;
  }

  async addFocusedSession(projectId, threadId) {
    const snapshot = await this.load();
    const project = ensureProject(snapshot, projectId);
    let changed = false;

    if (project.hidden) {
      project.hidden = false;
      changed = true;
    }

    if (!project.focusedThreadIds.includes(threadId)) {
      project.focusedThreadIds.push(threadId);
      changed = true;
    }

    if (changed) {
      await this.save(snapshot);
    }

    return project;
  }

  async addProject(projectId) {
    const snapshot = await this.load();
    const existed = Boolean(snapshot.projects[projectId]);
    const project = ensureProject(snapshot, projectId);
    if (project.hidden) {
      project.hidden = false;
      await this.save(snapshot);
      return project;
    }

    if (!existed) {
      await this.save(snapshot);
    }

    return project;
  }

  async removeFocusedSession(projectId, threadId) {
    const snapshot = await this.load();
    const project = ensureProject(snapshot, projectId);
    project.focusedThreadIds = project.focusedThreadIds.filter((id) => id !== threadId);
    await this.save(snapshot);
    return project;
  }

  async setCollapsed(projectId, collapsed) {
    const snapshot = await this.load();
    const project = ensureProject(snapshot, projectId);
    project.collapsed = Boolean(collapsed);
    await this.save(snapshot);
    return project;
  }

  async hideProject(projectId) {
    const snapshot = await this.load();
    const project = ensureProject(snapshot, projectId);
    project.hidden = true;
    project.collapsed = false;
    project.focusedThreadIds = [];
    await this.save(snapshot);
    return project;
  }

  async save(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    await writeJsonSnapshotFile(this.filePath, normalized);
    this.snapshot = normalized;
    return normalized;
  }
}

function ensureProject(snapshot, projectId) {
  if (!snapshot.projects[projectId]) {
    snapshot.projects[projectId] = {
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
    };
  }

  return snapshot.projects[projectId];
}

function normalizeSnapshot(snapshot) {
  const projects = {};

  for (const [projectId, project] of Object.entries(snapshot?.projects ?? {})) {
    projects[projectId] = {
      collapsed: Boolean(project?.collapsed),
      focusedThreadIds: [...new Set((project?.focusedThreadIds ?? []).filter(Boolean))],
      hidden: Boolean(project?.hidden),
    };
  }

  return {
    version: 1,
    projects,
  };
}
