import {
  normalizeApprovalEntry,
  normalizeExternalSession,
  normalizePendingApprovals,
  normalizePendingQuestionEntry,
  normalizePendingQuestions,
} from './thread-utils.js';
import { preferThreadText } from './text-utils.js';

export function keepSelectedSession(projects, selectedSessionId) {
  if (!selectedSessionId) {
    return null;
  }

  const allFocusedSessions = projects.flatMap((project) => project.focusedSessions ?? []);
  return allFocusedSessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : null;
}

export function keepDialogProject(projects, projectId) {
  if (!projectId) {
    return null;
  }

  return projects.some((project) => (project.id ?? project.cwd ?? '__unknown__') === projectId)
    ? projectId
    : null;
}

export function keepPendingProject(projects, projectId) {
  if (!projectId) {
    return null;
  }

  return projects.some((project) => (project.id ?? project.cwd ?? '__unknown__') === projectId)
    ? projectId
    : null;
}

export function normalizeSubagentDialogSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return null;
  }

  const threadId = String(selection.threadId ?? '').trim();
  const turnId = String(selection.turnId ?? '').trim();
  const itemId = String(selection.itemId ?? '').trim();

  if (!threadId || !turnId || !itemId) {
    return null;
  }

  return { threadId, turnId, itemId };
}

export function findTurnById(thread, turnId) {
  if (!thread?.turns?.length || !turnId) {
    return null;
  }

  return thread.turns.find((turn) => turn?.id === turnId) ?? null;
}

export function findTurnItemById(turn, itemId) {
  if (!turn?.items?.length || !itemId) {
    return null;
  }

  return turn.items.find((item) => item?.id === itemId) ?? null;
}

export function getSelectedSubagentDialogItem(state) {
  const selection = state?.subagentDialog;
  if (!selection) {
    return null;
  }

  const thread = state.sessionDetailsById?.[selection.threadId];
  const turn = findTurnById(thread, selection.turnId);
  if (!turn) {
    return null;
  }

  return findTurnItemById(turn, selection.itemId);
}

export function filterSessionCountMap(projects, counts) {
  const allowedIds = new Set();
  for (const project of projects ?? []) {
    for (const session of project.focusedSessions ?? []) {
      if (session?.id) {
        allowedIds.add(session.id);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(counts ?? {}).filter(([sessionId, count]) => allowedIds.has(sessionId) && Number(count) > 0),
  );
}


export function clearSessionUnread(unreadBySession, threadId) {
  if (!threadId || !unreadBySession?.[threadId]) {
    return unreadBySession ?? {};
  }

  return {
    ...unreadBySession,
    [threadId]: 0,
  };
}

export function markSessionUnreadIfBackground(state, threadId) {
  if (!threadId || threadId === state.selectedSessionId) {
    return state;
  }

  return {
    ...state,
    unreadBySession: {
      ...state.unreadBySession,
      [threadId]: 1,
    },
  };
}

export function updateProject(projects, projectId, updater) {
  return projects.map((project) => {
    const currentProjectId = project.id ?? project.cwd ?? '__unknown__';
    if (currentProjectId !== projectId) {
      return project;
    }

    return updater(project);
  });
}

export function findProject(projects, projectId) {
  return projects.find((project) => (project.id ?? project.cwd ?? '__unknown__') === projectId);
}

export function syncThreadIntoProjects(projects, thread) {
  if (!thread?.id) {
    return projects;
  }

  return projects.map((project) => {
    const active = syncThreadMetaList(project.historySessions?.active ?? [], thread);
    const archived = syncThreadMetaList(project.historySessions?.archived ?? [], thread);
    const focusedSessions = syncThreadMetaList(project.focusedSessions ?? [], thread);
    return {
      ...project,
      focusedSessions,
      historySessions: {
        active,
        archived,
      },
    };
  });
}

export function syncThreadMetaList(sessions, thread) {
  return sessions.map((session) => {
    if (session?.id !== thread.id) {
      return session;
    }

    return mergeThreadMeta(session, thread);
  });
}

export function mergeThreadMeta(session, thread) {
  const pendingApprovals =
    thread.pendingApprovals != null
      ? normalizePendingApprovals(thread.pendingApprovals)
      : normalizePendingApprovals(session.pendingApprovals);
  const derivedPendingApprovalCount =
    thread.pendingApprovals != null || session.pendingApprovals != null
      ? pendingApprovals.length
      : 0;
  const pendingApprovalCount = Number(
    thread.pendingApprovalCount ??
      session.pendingApprovalCount ??
      derivedPendingApprovalCount ??
      0,
  );
  const waitingOnApproval =
    typeof thread.waitingOnApproval === 'boolean'
      ? thread.waitingOnApproval
      : pendingApprovalCount > 0 || Boolean(session.waitingOnApproval);
  const pendingQuestions =
    thread.pendingQuestions != null
      ? normalizePendingQuestions(thread.pendingQuestions)
      : normalizePendingQuestions(session.pendingQuestions);
  const derivedPendingQuestionCount =
    thread.pendingQuestions != null || session.pendingQuestions != null
      ? pendingQuestions.length
      : 0;
  const pendingQuestionCount = Number(
    thread.pendingQuestionCount ??
      session.pendingQuestionCount ??
      derivedPendingQuestionCount ??
      0,
  );
  const waitingOnQuestion =
    typeof thread.waitingOnQuestion === 'boolean'
      ? thread.waitingOnQuestion
      : pendingQuestionCount > 0 || Boolean(session.waitingOnQuestion);
  const external = normalizeExternalSession(thread.external) ?? normalizeExternalSession(session.external);

  return {
    ...session,
    name: preferThreadText(thread.name, session.name),
    preview: preferThreadText(thread.preview, session.preview),
    cwd: thread.cwd ?? session.cwd ?? null,
    updatedAt: thread.updatedAt ?? session.updatedAt ?? null,
    status: thread.status ?? session.status ?? null,
    runtime: thread.runtime ?? session.runtime ?? null,
    pendingApprovalCount,
    waitingOnApproval,
    pendingApprovals,
    pendingQuestionCount,
    waitingOnQuestion,
    pendingQuestions,
    ...(external ? { external } : {}),
  };
}

export function applyApprovalUpdate(state, approval, mode) {
  const normalizedApproval = normalizeApprovalEntry(approval);
  if (!normalizedApproval?.threadId) {
    return state;
  }

  return {
    ...state,
    projects: updateApprovalInProjects(state.projects, normalizedApproval, mode),
    sessionDetailsById: updateApprovalInSessionDetails(
      state.sessionDetailsById,
      normalizedApproval,
      mode,
    ),
  };
}

export function applyPendingQuestionUpdate(state, question, mode) {
  const normalizedQuestion = normalizePendingQuestionEntry(question);
  if (!normalizedQuestion?.threadId) {
    return state;
  }

  return {
    ...state,
    projects: updatePendingQuestionInProjects(state.projects, normalizedQuestion, mode),
    sessionDetailsById: updatePendingQuestionInSessionDetails(
      state.sessionDetailsById,
      normalizedQuestion,
      mode,
    ),
  };
}

export function updateApprovalInProjects(projects, approval, mode) {
  return (projects ?? []).map((project) => ({
    ...project,
    focusedSessions: updateApprovalInThreadList(project.focusedSessions ?? [], approval, mode),
    historySessions: {
      active: updateApprovalInThreadList(project.historySessions?.active ?? [], approval, mode),
      archived: updateApprovalInThreadList(project.historySessions?.archived ?? [], approval, mode),
    },
  }));
}

export function updateApprovalInThreadList(threads, approval, mode) {
  return (threads ?? []).map((thread) => {
    if (thread?.id !== approval.threadId) {
      return thread;
    }

    return applyApprovalToThread(thread, approval, mode);
  });
}

export function updateApprovalInSessionDetails(sessionDetailsById, approval, mode) {
  const thread = sessionDetailsById?.[approval.threadId];
  if (!thread) {
    return sessionDetailsById;
  }

  return {
    ...sessionDetailsById,
    [approval.threadId]: applyApprovalToThread(thread, approval, mode),
  };
}

export function updatePendingQuestionInProjects(projects, question, mode) {
  return (projects ?? []).map((project) => ({
    ...project,
    focusedSessions: updatePendingQuestionInThreadList(project.focusedSessions ?? [], question, mode),
    historySessions: {
      active: updatePendingQuestionInThreadList(project.historySessions?.active ?? [], question, mode),
      archived: updatePendingQuestionInThreadList(project.historySessions?.archived ?? [], question, mode),
    },
  }));
}

export function updatePendingQuestionInThreadList(threads, question, mode) {
  return (threads ?? []).map((thread) => {
    if (thread?.id !== question.threadId) {
      return thread;
    }

    return applyPendingQuestionToThread(thread, question, mode);
  });
}

export function updatePendingQuestionInSessionDetails(sessionDetailsById, question, mode) {
  const thread = sessionDetailsById?.[question.threadId];
  if (!thread) {
    return sessionDetailsById;
  }

  return {
    ...sessionDetailsById,
    [question.threadId]: applyPendingQuestionToThread(thread, question, mode),
  };
}

export function applyApprovalToThread(thread, approval, mode) {
  const approvals = normalizePendingApprovals(thread?.pendingApprovals);
  let nextApprovals = approvals;

  if (mode === 'requested') {
    nextApprovals = upsertApproval(approvals, approval);
  } else if (mode === 'resolved') {
    nextApprovals = approvals.filter((entry) => entry.id !== approval.id);
  }

  return {
    ...thread,
    pendingApprovals: nextApprovals,
    pendingApprovalCount: nextApprovals.length,
    waitingOnApproval: nextApprovals.length > 0,
  };
}

export function applyPendingQuestionToThread(thread, question, mode) {
  const questions = normalizePendingQuestions(thread?.pendingQuestions);
  let nextQuestions = questions;

  if (mode === 'requested') {
    nextQuestions = upsertPendingQuestion(questions, question);
  } else if (mode === 'resolved') {
    nextQuestions = questions.filter((entry) => entry.id !== question.id);
  }

  return {
    ...thread,
    pendingQuestions: nextQuestions,
    pendingQuestionCount: nextQuestions.length,
    waitingOnQuestion: nextQuestions.length > 0,
  };
}

export function upsertApproval(approvals, approval) {
  const nextApprovals = [...approvals];
  const index = nextApprovals.findIndex((entry) => entry.id === approval.id);
  if (index === -1) {
    nextApprovals.push(approval);
  } else {
    nextApprovals[index] = approval;
  }

  return nextApprovals;
}

export function upsertPendingQuestion(questions, question) {
  const nextQuestions = [...questions];
  const index = nextQuestions.findIndex((entry) => entry.id === question.id);
  if (index === -1) {
    nextQuestions.push(question);
  } else {
    nextQuestions[index] = question;
  }

  return nextQuestions;
}

export function updateThreadNameInProjects(projects, threadId, name) {
  return projects.map((project) => ({
    ...project,
    focusedSessions: updateThreadNameInMetaList(project.focusedSessions ?? [], threadId, name),
    historySessions: {
      active: updateThreadNameInMetaList(project.historySessions?.active ?? [], threadId, name),
      archived: updateThreadNameInMetaList(project.historySessions?.archived ?? [], threadId, name),
    },
  }));
}

export function updateThreadNameInMetaList(sessions, threadId, name) {
  return sessions.map((session) => {
    if (session?.id !== threadId) {
      return session;
    }

    return {
      ...session,
      name,
    };
  });
}

export function updateThreadNameInSessionDetails(sessionDetailsById, threadId, name) {
  const detail = sessionDetailsById?.[threadId];
  if (!detail) {
    return sessionDetailsById;
  }

  return {
    ...sessionDetailsById,
    [threadId]: {
      ...detail,
      name,
    },
  };
}


export function getThreadTitle(session) {
  if (!session) {
    return null;
  }

  return [session.name, session.preview, session.id].find((value) => {
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    return Boolean(value);
  });
}

export function getThreadSubtitle(session) {
  if (!session) {
    return '打开后可查看完整历史';
  }

  const title = getThreadTitle(session);
  for (const candidate of [session.preview, session.cwd, session.id]) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim();
    if (!normalized || normalized === title) {
      continue;
    }

    return normalized;
  }

  return '打开后可查看完整历史';
}

export function resolveSelectedSessionTitle(state, detail) {
  if (detail) {
    return getThreadTitle(detail) ?? '';
  }

  if (state.pendingSessionProjectId) {
    return '新会话';
  }

  const selectedMeta = findThreadMeta(state.projects ?? [], state.selectedSessionId);
  return getThreadTitle(selectedMeta) ?? '';
}

export function getPendingSessionProject(state) {
  return findProject(state.projects ?? [], state.pendingSessionProjectId);
}

export function findThreadMeta(projects, threadId) {
  for (const project of projects ?? []) {
    for (const session of [
      ...(project.focusedSessions ?? []),
      ...(project.historySessions?.active ?? []),
      ...(project.historySessions?.archived ?? []),
    ]) {
      if (session?.id === threadId) {
        return session;
      }
    }
  }

  return null;
}
