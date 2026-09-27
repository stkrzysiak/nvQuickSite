// End-to-end: build a temporary projects folder with real git repos and a
// Backlog.md task set, boot the server on a random port, and drive the API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/index.js';

let root;
let dataDir;
let app;
let base;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString();

async function makeRepo(name, { files = {}, commits = 1 } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  for (let i = 0; i < commits; i++) {
    await fs.writeFile(path.join(dir, 'file.txt'), `rev ${i}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `commit ${i}`);
  }
  return dir;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-root-'));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-data-'));

  const alpha = await makeRepo('alpha', {
    commits: 3,
    files: {
      'README.md': '# Alpha\n\nA thing that does alpha stuff.\n',
      'package.json': JSON.stringify({ name: 'alpha', dependencies: { react: '1' } }),
      'backlog/config.yml': 'project_name: "alpha"\nstatuses: ["To Do", "In Progress", "Done"]\n',
      'backlog/tasks/task-1 - One.md': "---\nid: TASK-1\ntitle: One\nstatus: In Progress\npriority: high\nlabels: []\n---\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [x] #1 a\n- [ ] #2 b\n<!-- AC:END -->\n",
      'backlog/tasks/task-2 - Two.md': '---\nid: TASK-2\ntitle: Two\nstatus: Done\n---\n',
      'backlog/completed/task-0 - Zero.md': '---\nid: TASK-0\ntitle: Zero\nstatus: Done\n---\n',
    },
  });
  await fs.writeFile(path.join(alpha, 'dirty.txt'), 'uncommitted\n');
  await makeRepo('beta', { files: { 'go.mod': 'module beta\n' } });
  await fs.mkdir(path.join(root, 'plain'));
  await fs.mkdir(path.join(root, '.hidden-folder'));
  await fs.mkdir(path.join(root, 'skipped'));

  app = await createApp({ root, dataDir, port: 0, host: '127.0.0.1', scanInterval: 0, exclude: ['skipped'] });
  await app.start();
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.stop();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
});

const j = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('scan discovers repos, plain folders, and honours exclusions', async () => {
  const { status, body } = await j('GET', '/api/projects');
  assert.equal(status, 200);
  assert.deepEqual(body.projects.map((p) => p.id), ['alpha', 'beta', 'plain']);
  assert.equal(body.root, root);
  assert.ok(body.scannedAt);
});

test('git, backlog and stack facts for a project', async () => {
  const { body: p } = await j('GET', '/api/projects/alpha');
  assert.equal(p.git.branch, 'main');
  assert.equal(p.git.dirty, 1);
  assert.deepEqual(p.git.dirtyFiles, ['?? dirty.txt']);
  assert.equal(p.git.totalCommits, 3);
  assert.equal(p.git.commits7d, 3);
  assert.equal(p.git.hasUpstream, false);
  assert.equal(p.git.lastCommit.subject, 'commit 2');
  assert.equal(p.git.weekly.length, 12);
  assert.equal(p.git.weekly.at(-1).count, 3);

  assert.equal(p.backlog.counts.total, 3);
  assert.equal(p.backlog.counts.done, 2);
  const t1 = p.backlog.tasks.find((t) => t.id === 'TASK-1');
  assert.equal(t1.status, 'In Progress');
  assert.deepEqual(t1.acceptance, { done: 1, total: 2 });
  assert.ok(p.backlog.tasks.find((t) => t.id === 'TASK-0'), 'completed/ folder is read');

  assert.ok(p.stack.tags.includes('Node.js'));
  assert.ok(p.stack.tags.includes('React'));
  assert.equal(p.stack.readme.title, 'Alpha');
  assert.equal(p.stack.readme.summary, 'A thing that does alpha stuff.');

  assert.equal(p.derived.health, 'healthy');
  assert.deepEqual(p.derived.progress, { done: 2, total: 3, ratio: 2 / 3 });
  assert.equal(p.derived.inProgress, 1);
  assert.deepEqual(p.derived.nextUp.map((t) => t.id), ['TASK-1']);
});

test('a plain folder has no git or backlog and reports no data', async () => {
  const { body: p } = await j('GET', '/api/projects/plain');
  assert.equal(p.git, null);
  assert.equal(p.backlog, null);
  assert.equal(p.derived.health, 'unknown');
});

test('meta updates are validated and persisted', async () => {
  const bad = await j('PUT', '/api/projects/beta/meta', { status: 'bogus' });
  assert.equal(bad.status, 400);

  const ok = await j('PUT', '/api/projects/beta/meta', {
    summary: 'Beta does beta things',
    status: 'blocked',
    priority: 'high',
    blockers: 'need hardware\n\nneed time',
    targetDate: '2026-12-01',
    links: [{ label: 'Docs', url: 'https://example.com' }, { label: 'bad', url: 'javascript:alert(1)' }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.meta.status, 'blocked');
  assert.deepEqual(ok.body.meta.blockers, ['need hardware', 'need time']);
  assert.deepEqual(ok.body.meta.links, [{ label: 'Docs', url: 'https://example.com' }]);
  assert.equal(ok.body.derived.health, 'blocked');

  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'dashboard.json'), 'utf8'));
  assert.equal(saved.projects.beta.summary, 'Beta does beta things');

  const list = await j('GET', '/api/projects');
  assert.equal(list.body.summary.needsAttentionNames.includes('beta'), true);
});

test('questions: ask, answer, resolve, delete', async () => {
  const ask = await j('POST', '/api/projects/alpha/questions', { from: 'pm', text: 'When can I try it?' });
  assert.equal(ask.status, 200);
  const qid = ask.body.id;

  let p = (await j('GET', '/api/projects/alpha')).body;
  assert.equal(p.derived.openQuestions, 1);

  const ans = await j('PATCH', `/api/projects/alpha/questions/${qid}`, { answer: 'Friday', resolved: true });
  assert.equal(ans.body.answer, 'Friday');
  assert.equal(ans.body.resolved, true);
  p = (await j('GET', '/api/projects/alpha')).body;
  assert.equal(p.derived.openQuestions, 0);

  const empty = await j('POST', '/api/projects/alpha/questions', { from: 'pm', text: '   ' });
  assert.equal(empty.status, 400);

  const del = await j('DELETE', `/api/projects/alpha/questions/${qid}`);
  assert.equal(del.status, 204);
  const missing = await j('PATCH', `/api/projects/alpha/questions/${qid}`, { resolved: true });
  assert.equal(missing.status, 404);
});

test('settings round-trip', async () => {
  const { body } = await j('PUT', '/api/settings', { techName: 'Steve', pmName: 'Sam', title: 'Our projects' });
  assert.deepEqual(body, { techName: 'Steve', pmName: 'Sam', title: 'Our projects' });
});

test('unknown project and static routes', async () => {
  assert.equal((await j('GET', '/api/projects/nope')).status, 404);
  for (const p of ['/', '/pm', '/tech']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/projects`, { method: 'DELETE' })).status, 404);
});

test('refresh picks up a new project', async () => {
  await makeRepo('gamma');
  const { body } = await j('POST', '/api/refresh');
  assert.ok(body.projects.some((p) => p.id === 'gamma'));
});
