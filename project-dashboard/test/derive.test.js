import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHealth, deriveProgress, nextUp, decorate, summarise } from '../server/derive.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const backlog = (tasks) => ({
  statuses: ['To Do', 'In Progress', 'Done'],
  doneStatus: 'Done',
  tasks,
  counts: { total: tasks.length, done: tasks.filter((t) => t.status === 'Done').length, byStatus: {} },
});
const task = (id, status, extra = {}) => ({
  id,
  title: id,
  status,
  priority: null,
  ordinal: null,
  updatedDate: daysAgo(1),
  createdDate: daysAgo(3),
  acceptance: { done: 0, total: 0 },
  ...extra,
});
const project = (over = {}) => ({
  id: 'p',
  name: 'p',
  git: null,
  backlog: null,
  stack: null,
  meta: { status: 'active', blockers: [], questions: [], hidden: false, priority: 'medium' },
  ...over,
});

test('health from recency of activity', () => {
  assert.equal(deriveHealth(project({ git: { lastCommit: { date: daysAgo(2) } } }), NOW), 'healthy');
  assert.equal(deriveHealth(project({ git: { lastCommit: { date: daysAgo(15) } } }), NOW), 'slowing');
  assert.equal(deriveHealth(project({ git: { lastCommit: { date: daysAgo(45) } } }), NOW), 'stalled');
});

test('a recent backlog update keeps a project healthy even without commits', () => {
  const p = project({ git: { lastCommit: { date: daysAgo(60) } }, backlog: backlog([task('T1', 'In Progress', { updatedDate: daysAgo(1) })]) });
  assert.equal(deriveHealth(p, NOW), 'healthy');
});

test('blockers and lifecycle override recency', () => {
  const recent = { lastCommit: { date: daysAgo(1) } };
  assert.equal(deriveHealth(project({ git: recent, meta: { status: 'active', blockers: ['waiting on API key'], questions: [] } }), NOW), 'blocked');
  assert.equal(deriveHealth(project({ git: recent, meta: { status: 'blocked', blockers: [], questions: [] } }), NOW), 'blocked');
  assert.equal(deriveHealth(project({ git: recent, meta: { status: 'shipped', blockers: [], questions: [] } }), NOW), 'dormant');
  assert.equal(deriveHealth(project({ git: recent, meta: { status: 'paused', blockers: [], questions: [] } }), NOW), 'dormant');
  assert.equal(deriveHealth(project(), NOW), 'unknown');
});

test('progress ratio from backlog counts', () => {
  assert.equal(deriveProgress(null), null);
  assert.equal(deriveProgress(backlog([])), null);
  assert.deepEqual(deriveProgress(backlog([task('a', 'Done'), task('b', 'To Do')])), { done: 1, total: 2, ratio: 0.5 });
});

test('next up: in-progress first, then priority, then backlog order', () => {
  const b = backlog([
    task('low-todo', 'To Do', { priority: 'low', ordinal: 1 }),
    task('high-todo', 'To Do', { priority: 'high', ordinal: 5 }),
    task('done', 'Done'),
    task('wip', 'In Progress', { priority: 'low', ordinal: 9 }),
    task('med-a', 'To Do', { priority: 'medium', ordinal: 2 }),
    task('med-b', 'To Do', { priority: 'medium', ordinal: 1 }),
  ]);
  assert.deepEqual(nextUp(b, 4).map((t) => t.id), ['wip', 'high-todo', 'med-b', 'med-a']);
});

test('summary counts across projects', () => {
  const projects = [
    decorate(project({ id: 'a', name: 'a', git: { lastCommit: { date: daysAgo(1) }, commits7d: 3, commits30d: 5, dirty: 2, ahead: 1, weekly: [] }, backlog: backlog([task('t', 'Done', { updatedDate: daysAgo(2) }), task('u', 'In Progress')]) }), NOW),
    decorate(project({ id: 'b', name: 'b', git: { lastCommit: { date: daysAgo(40) }, commits7d: 0, commits30d: 0, dirty: 0, ahead: 0, weekly: [] } }), NOW),
    decorate(project({ id: 'c', name: 'c', meta: { status: 'active', blockers: [], questions: [{ resolved: false }], hidden: true } }), NOW),
  ];
  const s = summarise(projects, NOW);
  assert.equal(s.projects, 2, 'hidden projects are excluded');
  assert.equal(s.activeProjects, 1);
  assert.equal(s.commits7d, 3);
  assert.equal(s.doneThisWeek, 1);
  assert.equal(s.inProgress, 1);
  assert.equal(s.needsAttention, 1);
  assert.deepEqual(s.needsAttentionNames, ['b']);
  assert.equal(s.dirtyRepos, 1);
  assert.equal(s.unpushed, 1);
  assert.equal(s.openQuestions, 0);
});
