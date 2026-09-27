// The dashboard's own state: the project-management layer (status, summary,
// blockers, questions...) that does not live in any project repo. One JSON
// file in DATA_DIR, written atomically.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIFECYCLE, PRIORITIES } from './derive.js';

const FILE = 'dashboard.json';

export const DEFAULT_META = Object.freeze({
  displayName: '',
  summary: '',
  status: 'active',
  priority: 'medium',
  owner: '',
  targetDate: '',
  nextMilestone: '',
  blockers: [],
  notes: '',
  links: [],
  hidden: false,
  questions: [],
});

const DEFAULT_SETTINGS = Object.freeze({
  techName: 'Tech',
  pmName: 'PM',
  title: 'Projects',
});

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, FILE);
    this.state = { settings: { ...DEFAULT_SETTINGS }, projects: {} };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        projects: raw.projects ?? {},
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
    }
    return this;
  }

  settings() {
    return { ...this.state.settings };
  }

  async updateSettings(patch) {
    const next = { ...this.state.settings };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof patch[key] === 'string') next[key] = patch[key].trim().slice(0, 80) || DEFAULT_SETTINGS[key];
    }
    this.state.settings = next;
    await this.persist();
    return this.settings();
  }

  meta(id) {
    return { ...DEFAULT_META, ...(this.state.projects[id] ?? {}) };
  }

  async updateMeta(id, patch) {
    const current = this.meta(id);
    const next = { ...current, ...sanitiseMeta(patch), questions: current.questions };
    this.state.projects[id] = next;
    await this.persist();
    return next;
  }

  async addQuestion(id, { from, text }) {
    const meta = this.meta(id);
    const q = {
      id: randomUUID(),
      from: from === 'tech' ? 'tech' : 'pm',
      text: String(text ?? '').trim().slice(0, 2000),
      createdAt: new Date().toISOString(),
      answer: '',
      answeredAt: null,
      resolved: false,
    };
    if (!q.text) throw new ValidationError('Question text is required');
    meta.questions = [...meta.questions, q];
    this.state.projects[id] = meta;
    await this.persist();
    return q;
  }

  async updateQuestion(id, qid, patch) {
    const meta = this.meta(id);
    const q = meta.questions.find((x) => x.id === qid);
    if (!q) throw new NotFoundError('Question not found');
    if (typeof patch.answer === 'string') {
      q.answer = patch.answer.trim().slice(0, 4000);
      q.answeredAt = q.answer ? new Date().toISOString() : null;
    }
    if (typeof patch.resolved === 'boolean') q.resolved = patch.resolved;
    if (typeof patch.text === 'string' && patch.text.trim()) q.text = patch.text.trim().slice(0, 2000);
    this.state.projects[id] = meta;
    await this.persist();
    return q;
  }

  async deleteQuestion(id, qid) {
    const meta = this.meta(id);
    meta.questions = meta.questions.filter((x) => x.id !== qid);
    this.state.projects[id] = meta;
    await this.persist();
  }

  persist() {
    // Serialise writes so two quick edits cannot interleave a torn file.
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}

export class ValidationError extends Error {
  status = 400;
}
export class NotFoundError extends Error {
  status = 404;
}

function sanitiseMeta(patch) {
  const out = {};
  const str = (k, max = 2000) => {
    if (typeof patch[k] === 'string') out[k] = patch[k].trim().slice(0, max);
  };
  str('displayName', 80);
  str('summary', 2000);
  str('owner', 80);
  str('nextMilestone', 200);
  str('notes', 8000);
  if (typeof patch.targetDate === 'string') {
    const d = patch.targetDate.trim();
    if (d === '' || /^\d{4}-\d{2}-\d{2}$/.test(d)) out.targetDate = d;
    else throw new ValidationError('targetDate must be YYYY-MM-DD');
  }
  if (patch.status !== undefined) {
    if (!LIFECYCLE.includes(patch.status)) throw new ValidationError(`status must be one of ${LIFECYCLE.join(', ')}`);
    out.status = patch.status;
  }
  if (patch.priority !== undefined) {
    if (!PRIORITIES.includes(patch.priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(', ')}`);
    out.priority = patch.priority;
  }
  if (patch.blockers !== undefined) out.blockers = toStringList(patch.blockers, 500, 50);
  if (patch.links !== undefined) {
    out.links = (Array.isArray(patch.links) ? patch.links : [])
      .map((l) => (typeof l === 'string' ? { label: l, url: l } : l))
      .filter((l) => l && typeof l.url === 'string' && /^https?:\/\//.test(l.url))
      .map((l) => ({ label: String(l.label ?? l.url).slice(0, 80), url: l.url.slice(0, 500) }))
      .slice(0, 20);
  }
  if (typeof patch.hidden === 'boolean') out.hidden = patch.hidden;
  return out;
}

function toStringList(v, maxLen, maxItems) {
  const list = Array.isArray(v) ? v : String(v ?? '').split('\n');
  return list
    .map((s) => String(s).trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}
