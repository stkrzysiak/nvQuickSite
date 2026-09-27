// Walks PROJECTS_ROOT one level deep and builds a snapshot of every project:
// git state, Backlog.md tasks, stack markers and README summary. The snapshot
// is cached; refresh() rescans (deduplicated if one is already running).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isGitRepo, readGit } from './git.js';
import { readBacklog } from './backlog.js';
import { readStack } from './stack.js';

export class Scanner {
  constructor({ root, exclude = [], concurrency = 4, log = console }) {
    this.root = root;
    this.exclude = new Set(exclude);
    this.concurrency = concurrency;
    this.log = log;
    this.snapshot = { scannedAt: null, durationMs: 0, projects: [], errors: [] };
    this.inflight = null;
  }

  get() {
    return this.snapshot;
  }

  refresh() {
    if (!this.inflight) {
      this.inflight = this.scan().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async scan() {
    const started = Date.now();
    const now = new Date();
    const errors = [];
    let dirs = [];
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      dirs = entries
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !this.exclude.has(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch (err) {
      errors.push({ project: null, message: `Cannot read ${this.root}: ${err.message}` });
    }

    const projects = await mapLimit(dirs, this.concurrency, async (name) => {
      const dir = path.join(this.root, name);
      try {
        const st = await fs.stat(dir);
        if (!st.isDirectory()) return null;
        return await this.inspect(name, dir, now);
      } catch (err) {
        errors.push({ project: name, message: err.message });
        return { id: name, name, path: dir, git: null, backlog: null, stack: null, error: err.message };
      }
    });

    this.snapshot = {
      scannedAt: now.toISOString(),
      durationMs: Date.now() - started,
      projects: projects.filter(Boolean),
      errors,
    };
    this.log.info?.(`scan: ${this.snapshot.projects.length} projects in ${this.snapshot.durationMs}ms`);
    return this.snapshot;
  }

  async inspect(name, dir, now) {
    const [repo, backlog, stack] = await Promise.all([
      isGitRepo(dir).then((yes) => (yes ? readGit(dir, { now }) : null)),
      readBacklog(dir),
      readStack(dir),
    ]);
    return { id: name, name, path: dir, git: repo, backlog, stack, error: null };
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
