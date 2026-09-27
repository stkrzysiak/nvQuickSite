// Reads a project's Backlog.md folder (https://backlog.md) without the CLI:
// backlog/config.yml for the status list, backlog/tasks/*.md (plus
// backlog/completed/*.md when the project archives done tasks) for the tasks.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontMatter } from './frontmatter.js';

const DEFAULT_STATUSES = ['To Do', 'In Progress', 'Done'];
const TASK_DIRS = ['tasks', 'completed'];

export async function readBacklog(projectDir) {
  const dir = path.join(projectDir, 'backlog');
  if (!(await isDir(dir))) return null;

  const config = await readConfig(path.join(dir, 'config.yml'));
  const statuses = config.statuses?.length ? config.statuses : DEFAULT_STATUSES;
  const doneStatus = statuses[statuses.length - 1];

  const tasks = [];
  for (const sub of TASK_DIRS) {
    const tdir = path.join(dir, sub);
    if (!(await isDir(tdir))) continue;
    const names = (await fs.readdir(tdir)).filter((n) => n.endsWith('.md')).sort();
    for (const name of names) {
      const file = path.join(tdir, name);
      try {
        const task = await readTask(file, sub === 'completed' ? doneStatus : null);
        if (task) tasks.push(task);
      } catch {
        // A malformed task file should not take the whole project down.
      }
    }
  }

  const byStatus = {};
  for (const s of statuses) byStatus[s] = 0;
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  return {
    projectName: config.project_name ?? null,
    statuses,
    doneStatus,
    tasks,
    counts: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === doneStatus).length,
      byStatus,
    },
  };
}

async function readConfig(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    // config.yml has no front matter fence; reuse the block parser by wrapping it.
    const { data } = parseFrontMatter(`---\n${text}\n---\n`);
    return data;
  } catch {
    return {};
  }
}

async function readTask(file, forcedStatus) {
  const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
  const { data, body } = parseFrontMatter(text);
  if (!data.id && !data.title) return null;

  const ac = countAcceptanceCriteria(body);
  return {
    id: String(data.id ?? path.basename(file, '.md').split(' ')[0]),
    title: String(data.title ?? ''),
    status: String(forcedStatus ?? data.status ?? 'To Do'),
    priority: data.priority ? String(data.priority).toLowerCase() : null,
    labels: toList(data.labels),
    assignee: toList(data.assignee),
    dependencies: toList(data.dependencies),
    createdDate: toIso(data.created_date),
    updatedDate: toIso(data.updated_date) ?? stat.mtime.toISOString(),
    ordinal: typeof data.ordinal === 'number' ? data.ordinal : null,
    acceptance: ac,
    description: extractDescription(body),
    file: path.basename(file),
  };
}

function countAcceptanceCriteria(body) {
  const block = /<!-- AC:BEGIN -->([\s\S]*?)<!-- AC:END -->/.exec(body)?.[1] ?? body;
  const done = (block.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  const open = (block.match(/^\s*- \[ \]/gm) ?? []).length;
  return { done, total: done + open };
}

function extractDescription(body) {
  let text =
    /<!-- SECTION:DESCRIPTION:BEGIN -->([\s\S]*?)<!-- SECTION:DESCRIPTION:END -->/.exec(body)?.[1] ??
    /## Description\s*\n([\s\S]*?)(?:\n## |$)/.exec(body)?.[1] ??
    '';
  text = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

function toList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
}

// Backlog writes 'yyyy-mm-dd HH:MM' (local time, quoted). Normalise to ISO
// without pretending to know the zone: treat it as local server time.
function toIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
