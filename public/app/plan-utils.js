import { firstNonEmptyText } from './text-utils.js';

export function extractLatestTurnPlan(session) {
  const turns = [...(session?.turns ?? [])];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnPlan = normalizeTurnPlan(turn?.plan);
    if (turnPlan) {
      return turnPlan;
    }

    const itemPlan = extractTurnPlanFromItems(turn?.items ?? []);
    if (itemPlan) {
      return itemPlan;
    }
  }

  return null;
}

export function extractTurnPlanFromItems(items) {
  const plans = (items ?? []).filter((item) => item?.type === 'plan');
  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeTurnPlan(plans[index]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function normalizeTurnPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    return null;
  }

  const explanation = firstNonEmptyText(plan.explanation);
  const text = firstNonEmptyText(plan.text);
  const stepSource = Array.isArray(plan.steps)
    ? plan.steps
    : Array.isArray(plan.plan)
      ? plan.plan
      : [];
  const steps = stepSource
    .map((step) => normalizePlanStep(step))
    .filter(Boolean);

  if (!explanation && !text && !steps.length) {
    return null;
  }

  return {
    explanation: explanation || null,
    text: text || '',
    steps,
  };
}

export function mergeTurnPlan(currentPlan, payload) {
  const current = normalizeTurnPlan(currentPlan) ?? { explanation: null, text: '', steps: [] };
  const next = normalizeTurnPlan({
    explanation: payload?.explanation ?? current.explanation,
    text: payload?.text ?? current.text,
    steps: Array.isArray(payload?.plan) ? payload.plan : current.steps,
  });
  return next ?? current;
}

export function normalizePlanStep(step) {
  if (!step || typeof step !== 'object') {
    return null;
  }

  const text = firstNonEmptyText(step.step, step.text, step.title);
  if (!text) {
    return null;
  }

  return {
    step: text,
    status: normalizePlanStepStatus(step.status),
  };
}

export function normalizePlanStepStatus(status) {
  if (status === 'completed' || status === 'inProgress') {
    return status;
  }

  return 'pending';
}

export function formatPlanStepStatus(status) {
  switch (normalizePlanStepStatus(status)) {
    case 'completed':
      return '已完成';
    case 'inProgress':
      return '进行中';
    default:
      return '待处理';
  }
}

export function getPlanStepTone(status) {
  switch (normalizePlanStepStatus(status)) {
    case 'completed':
      return 'completed';
    case 'inProgress':
      return 'running';
    default:
      return 'pending';
  }
}
