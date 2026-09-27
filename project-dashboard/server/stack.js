// Detects what a project is built with from marker files at its root, and
// pulls the README title/summary so the dashboard can describe a project
// nobody has annotated yet.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const MARKERS = [
  { file: 'package.json', add: ['Node.js'] },
  { file: 'pubspec.yaml', add: ['Flutter/Dart'] },
  { file: 'pyproject.toml', add: ['Python'] },
  { file: 'requirements.txt', add: ['Python'] },
  { file: 'setup.py', add: ['Python'] },
  { file: 'go.mod', add: ['Go'] },
  { file: 'Cargo.toml', add: ['Rust'] },
  { file: 'mix.exs', add: ['Elixir'] },
  { file: 'Gemfile', add: ['Ruby'] },
  { file: 'composer.json', add: ['PHP'] },
  { file: 'flake.nix', add: ['Nix'] },
  { file: 'shell.nix', add: ['Nix'] },
  { file: 'default.nix', add: ['Nix'] },
  { file: 'Dockerfile', add: ['Docker'] },
  { file: 'docker-compose.yml', add: ['Docker Compose'] },
  { file: 'docker-compose.yaml', add: ['Docker Compose'] },
  { file: 'compose.yml', add: ['Docker Compose'] },
  { file: 'compose.yaml', add: ['Docker Compose'] },
  { file: 'Makefile', add: ['Make'] },
  { file: '.envrc', add: ['direnv'] },
  { file: '.envrc.example', add: ['direnv'] },
  { file: 'CLAUDE.md', add: ['Claude Code'] },
  { file: 'AGENTS.md', add: ['Agents'] },
];

const EXT_MARKERS = [
  { ext: '.csproj', add: ['.NET'] },
  { ext: '.sln', add: ['.NET'] },
  { ext: '.fsproj', add: ['.NET'] },
  { ext: '.tf', add: ['Terraform'] },
];

const NODE_FRAMEWORKS = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['hono', 'Hono'],
  ['vite', 'Vite'],
  ['electron', 'Electron'],
  ['typescript', 'TypeScript'],
];

export async function readStack(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return emptyStack();
  }
  const names = new Set(entries.map((e) => e.name));
  const tags = new Set();

  for (const m of MARKERS) if (names.has(m.file)) m.add.forEach((t) => tags.add(t));
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    for (const m of EXT_MARKERS) if (ext === m.ext) m.add.forEach((t) => tags.add(t));
  }

  const [pkg, makeTargets, workflows, readme] = await Promise.all([
    names.has('package.json') ? readJson(path.join(dir, 'package.json')) : null,
    names.has('Makefile') ? readMakeTargets(path.join(dir, 'Makefile')) : [],
    names.has('.github') ? readWorkflows(path.join(dir, '.github', 'workflows')) : [],
    readReadme(dir, entries),
  ]);

  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [dep, label] of NODE_FRAMEWORKS) if (dep in deps) tags.add(label);
  }
  if (workflows.length) tags.add('GitHub Actions');

  return {
    tags: [...tags],
    packageName: pkg?.name ?? null,
    packageDescription: pkg?.description ?? null,
    scripts: pkg?.scripts ? Object.keys(pkg.scripts).slice(0, 30) : [],
    makeTargets,
    workflows,
    readme,
  };
}

function emptyStack() {
  return { tags: [], packageName: null, packageDescription: null, scripts: [], makeTargets: [], workflows: [], readme: null };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readMakeTargets(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const targets = new Set();
    for (const line of text.split('\n')) {
      const m = /^([A-Za-z0-9][A-Za-z0-9_./-]*)\s*:(?!=)/.exec(line);
      if (m && !m[1].startsWith('.')) targets.add(m[1]);
    }
    return [...targets].slice(0, 40);
  } catch {
    return [];
  }
}

async function readWorkflows(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => /\.ya?ml$/.test(n)).map((n) => n.replace(/\.ya?ml$/, ''));
  } catch {
    return [];
  }
}

async function readReadme(dir, entries) {
  const name = entries.find((e) => e.isFile() && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name))?.name;
  if (!name) return null;
  try {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    return summariseReadme(text);
  } catch {
    return null;
  }
}

// Title = first H1; summary = first plain paragraph after it (skipping badges,
// images, HTML and headings).
export function summariseReadme(text) {
  const lines = text.split(/\r?\n/);
  let title = null;
  const para = [];
  let seenContent = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!title) {
      const h1 = /^#\s+(.+)$/.exec(line);
      if (h1) title = h1[1].replace(/[*_`]/g, '').trim();
      continue;
    }
    if (line === '') {
      if (para.length) break;
      continue;
    }
    if (/^(#|!\[|<|\[!\[|\[!\[|---|\||```|>|- |\* |\d+\. )/.test(line)) {
      if (para.length) break;
      continue;
    }
    seenContent = true;
    para.push(line);
    if (para.join(' ').length > 400) break;
  }
  let summary = para.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
  if (summary.length > 400) summary = `${summary.slice(0, 397)}...`;
  return { title, summary: seenContent ? summary : null };
}
