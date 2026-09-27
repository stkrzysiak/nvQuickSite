// Pure derivations shared by both views: health, progress, "next up", and the
// plain-language weekly digest. No I/O here so it is trivially testable.

const MS_DAY = 86_400_000;

export const LIFECYCLE = ['active', 'blocked', 'paused', 'idea', 'shipped', 'archived'];
export const PRIORITIES = ['high', 'medium', 'low'];

// Health answers "does this project need attention?", and the answer must
// never depend on hue alone: each level has an icon and a label in the UI.
export const HEALTH = {
  healthy: { label: 'Healthy', tone: 'good', order: 0 },
  slowing: { label: 'Slowing', tone: 'warning', order: 1 },
  stalled: { label: 'Stalled', tone: 'serious', order: 2 },
  blocked: { label: 'Blocked', tone: 'critical', order: 3 },
  dormant: { label: 'Dormant', tone: 'neutral', order: 4 },
  unknown: { label: 'No data', tone: 'neutral', order: 5 },
};

export function daysSince(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / MS_DAY));
}

export function lastActivity(project) {
  const candidates = [project.git?.lastCommit?.date];
  for (const t of project.backlog?.tasks ?? []) candidates.push(t.updatedDate, t.createdDate);
  const times = candidates.filter(Boolean).map((d) => new Date(d).getTime()).filter((n) => !Number.isNaN(n));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

export function deriveHealth(project, now) {
  const meta = project.meta ?? {};
  if (['shipped', 'archived', 'idea'].includes(meta.status)) return 'dormant';
  if (meta.status === 'blocked' || (meta.blockers?.length ?? 0) > 0) return 'blocked';
  if (meta.status === 'paused') return 'dormant';
  if (!project.git && !project.backlog) return 'unknown';
  const days = daysSince(lastActivity(project), now);
  if (days === null) return 'stalled';
  if (days <= 7) return 'healthy';
  if (days <= 30) return 'slowing';
  return 'stalled';
}

export function deriveProgress(backlog) {
  if (!backlog || backlog.counts.total === 0) return null;
  return { done: backlog.counts.done, total: backlog.counts.total, ratio: backlog.counts.done / backlog.counts.total };
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// What the partner would ask "what's next?" about: in-progress tasks first,
// then the highest-priority open ones, in backlog order.
export function nextUp(backlog, limit = 5) {
  if (!backlog) return [];
  const { statuses, doneStatus, tasks } = backlog;
  const inProgress = statuses.filter((s) => s !== statuses[0] && s !== doneStatus);
  const open = tasks.filter((t) => t.status !== doneStatus);
  open.sort((a, b) => {
    const ap = inProgress.includes(a.status) ? 0 : 1;
    const bp = inProgress.includes(b.status) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const pr = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
    if (pr !== 0) return pr;
    return (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity);
  });
  return open.slice(0, limit);
}

export function tasksInProgress(backlog) {
  if (!backlog) return [];
  const { statuses, doneStatus, tasks } = backlog;
  return tasks.filter((t) => t.status !== statuses[0] && t.status !== doneStatus);
}

export function tasksDoneWithin(backlog, days, now) {
  if (!backlog) return [];
  return backlog.tasks.filter((t) => t.status === backlog.doneStatus && within(t.updatedDate, days, now));
}

function within(iso, days, now) {
  const d = daysSince(iso, now);
  return d !== null && d <= days;
}

export function decorate(project, now) {
  const health = deriveHealth(project, now);
  return {
    ...project,
    derived: {
      health,
      healthLabel: HEALTH[health].label,
      healthTone: HEALTH[health].tone,
      lastActivity: lastActivity(project),
      daysSinceActivity: daysSince(lastActivity(project), now),
      progress: deriveProgress(project.backlog),
      nextUp: nextUp(project.backlog),
      inProgress: tasksInProgress(project.backlog).length,
      openTasks: project.backlog ? project.backlog.counts.total - project.backlog.counts.done : 0,
      doneThisWeek: tasksDoneWithin(project.backlog, 7, now).length,
      doneLastWeek: tasksDoneWithin(project.backlog, 14, now).length - tasksDoneWithin(project.backlog, 7, now).length,
      openQuestions: (project.meta?.questions ?? []).filter((q) => !q.resolved).length,
    },
  };
}

// Numbers for the KPI rows and the "this week" digest, over the visible set.
export function summarise(projects, now) {
  const visible = projects.filter((p) => !p.meta?.hidden);
  const activeProjects = visible.filter((p) => p.git?.commits7d > 0 || p.derived.doneThisWeek > 0 || p.derived.inProgress > 0);
  const commits7d = visible.reduce((n, p) => n + (p.git?.commits7d ?? 0), 0);
  const commitsPrev7d = visible.reduce((n, p) => n + ((p.git?.commits30d ?? 0) >= (p.git?.commits7d ?? 0) ? prevWeek(p.git) : 0), 0);
  const doneThisWeek = visible.reduce((n, p) => n + p.derived.doneThisWeek, 0);
  const doneLastWeek = visible.reduce((n, p) => n + p.derived.doneLastWeek, 0);
  const inProgress = visible.reduce((n, p) => n + p.derived.inProgress, 0);
  const needsAttention = visible.filter((p) => ['stalled', 'blocked'].includes(p.derived.health));
  const openQuestions = visible.reduce((n, p) => n + p.derived.openQuestions, 0);

  return {
    projects: visible.length,
    repos: visible.filter((p) => p.git).length,
    withBacklog: visible.filter((p) => p.backlog).length,
    activeProjects: activeProjects.length,
    commits7d,
    commitsPrev7d,
    doneThisWeek,
    doneLastWeek,
    inProgress,
    needsAttention: needsAttention.length,
    needsAttentionNames: needsAttention.map((p) => p.name),
    dirtyRepos: visible.filter((p) => (p.git?.dirty ?? 0) > 0).length,
    unpushed: visible.reduce((n, p) => n + (p.git?.ahead ?? 0), 0),
    openQuestions,
    projectsTouched: activeProjects.map((p) => p.name),
    generatedAt: now.toISOString(),
  };
}

function prevWeek(git) {
  if (!git?.weekly?.length) return 0;
  return git.weekly[git.weekly.length - 2]?.count ?? 0;
}
