import { basename } from 'node:path';
import {
  clonePendingActionRecord,
  createApprovalRecordFromPendingAction,
  createPendingQuestionRecordFromPendingAction,
  listPendingApprovalsFromPendingActions,
  listPendingQuestionsFromPendingActions,
  normalizeApprovalMode,
  normalizePendingActionRecord,
} from './runtime-store.js';



export function createInMemoryActivityStore() {
  const snapshot = {
    projects: {},
  };

  return {
    async load() {
      return snapshot;
    },
    async addFocusedSession(projectId, threadId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.hidden = false;
      if (!project.focusedThreadIds.includes(threadId)) {
        project.focusedThreadIds.push(threadId);
      }
    },
    async addProject(projectId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.hidden = false;
    },
    async removeFocusedSession(projectId, threadId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.focusedThreadIds = project.focusedThreadIds.filter((id) => id !== threadId);
    },
    async setCollapsed(projectId, collapsed) {
      const project = ensureActivityProject(snapshot, projectId);
      project.collapsed = Boolean(collapsed);
    },
    async hideProject(projectId) {
      const project = ensureActivityProject(snapshot, projectId);
      project.hidden = true;
      project.collapsed = false;
      project.focusedThreadIds = [];
    },
  };
}


export function ensureActivityProject(snapshot, projectId) {
  if (!snapshot.projects[projectId]) {
    snapshot.projects[projectId] = {
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
    };
  }

  return snapshot.projects[projectId];
}

export function buildProjects(activeThreads, archivedThreads, activityProjects, knownThreads = []) {
  const projectsByCwd = new Map();

  for (const thread of activeThreads) {
    ensureProject(projectsByCwd, thread).historySessions.active.push(thread);
  }

  for (const thread of archivedThreads) {
    ensureProject(projectsByCwd, thread).historySessions.archived.push(thread);
  }

  for (const [projectId, project] of Object.entries(activityProjects)) {
    const projectRecord = ensureProject(projectsByCwd, {
      cwd: projectId,
    });
    projectRecord.collapsed = Boolean(project?.collapsed);
    projectRecord.hidden = Boolean(project?.hidden);
    projectRecord.focusedThreadIds = [...(project?.focusedThreadIds ?? [])];
  }

  return [...projectsByCwd.values()]
    .filter((project) => !project.hidden)
    .map((project) => {
      const activeHistory = sortThreads(project.historySessions.active);
      const archivedHistory = sortThreads(project.historySessions.archived);
      const focusedSessions = buildFocusedSessions(project, activeHistory, archivedHistory, knownThreads);
      const focusedIds = new Set(focusedSessions.map((thread) => thread.id));
      const updatedAt = Math.max(
        0,
        ...focusedSessions.map((thread) => thread.updatedAt ?? 0),
        ...activeHistory.map((thread) => thread.updatedAt ?? 0),
        ...archivedHistory.map((thread) => thread.updatedAt ?? 0),
      );

      return {
        id: project.id,
        cwd: project.cwd,
        displayName: project.displayName,
        collapsed: project.collapsed,
        focusedSessions,
        historySessions: {
          active: activeHistory.filter((thread) => !focusedIds.has(thread.id)),
          archived: archivedHistory.filter((thread) => !focusedIds.has(thread.id)),
        },
        updatedAt,
      };
    })
    .sort((left, right) => {
      if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      }

      return left.displayName.localeCompare(right.displayName);
    });
}

export function ensureProject(projectsByCwd, thread) {
  const cwd = thread.cwd ?? '__unknown__';
  if (!projectsByCwd.has(cwd)) {
    projectsByCwd.set(cwd, {
      id: cwd,
      cwd: thread.cwd ?? null,
      displayName: thread.cwd ? basename(thread.cwd) : 'Unknown Workspace',
      collapsed: false,
      focusedThreadIds: [],
      hidden: false,
      historySessions: {
        active: [],
        archived: [],
      },
      updatedAt: 0,
    });
  }

  return projectsByCwd.get(cwd);
}

export function buildFocusedSessions(project, activeHistory, archivedHistory, knownThreads) {
  const threadsById = new Map();

  for (const thread of [...knownThreads, ...activeHistory, ...archivedHistory]) {
    if (thread?.id) {
      threadsById.set(thread.id, thread);
    }
  }

  return project.focusedThreadIds
    .map((threadId) => threadsById.get(threadId))
    .filter(Boolean);
}

export function sortThreads(threads) {
  return [...threads].sort((left, right) => {
    if ((right.updatedAt ?? 0) !== (left.updatedAt ?? 0)) {
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    }

    return (left.name ?? left.preview ?? left.id).localeCompare(right.name ?? right.preview ?? right.id);
  });
}
