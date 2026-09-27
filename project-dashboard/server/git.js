// Read-only git inspection for one project directory. Every command runs with
// --no-optional-locks so a scan never touches the index of a repo someone is
// working in, and with a timeout so one huge repo cannot stall the scan.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SEP = '\x1f';
const WEEKS = 12;
const MS_DAY = 86_400_000;

export async function isGitRepo(dir) {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function readGit(dir, { now = new Date(), timeoutMs = 8000 } = {}) {
  const git = (args, opts = {}) => run(dir, args, { timeoutMs, ...opts });

  const [branch, head, log, dates, status, remote, stash, total, todos, upstream] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD'),
    git(['rev-parse', '--short', 'HEAD']).catch(() => null),
    git(['log', '-n', '25', `--format=%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s`]).catch(() => ''),
    git(['log', `--since=${WEEKS * 7}.days`, '--format=%aI']).catch(() => ''),
    git(['status', '--porcelain']).catch(() => ''),
    git(['remote', 'get-url', 'origin']).catch(() => null),
    git(['stash', 'list']).catch(() => ''),
    git(['rev-list', '--count', 'HEAD']).catch(() => null),
    countTodos(git),
    git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).catch(() => null),
  ]);

  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, author, date, subject] = line.split(SEP);
      return { sha, short, author, date, subject };
    });

  const commitDates = dates.split('\n').filter(Boolean).map((d) => new Date(d));
  const weekly = bucketWeekly(commitDates, now);

  const dirtyFiles = status.split('\n').filter(Boolean);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const [b, a] = upstream.split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  }

  return {
    branch,
    head,
    remote: remote ? normaliseRemote(remote) : null,
    lastCommit: commits[0] ?? null,
    commits,
    totalCommits: total !== null ? Number(total) : null,
    commits7d: commitDates.filter((d) => now - d <= 7 * MS_DAY).length,
    commits30d: commitDates.filter((d) => now - d <= 30 * MS_DAY).length,
    weekly, // oldest -> newest, WEEKS entries
    dirty: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, 50),
    stashes: stash ? stash.split('\n').filter(Boolean).length : 0,
    hasUpstream: upstream !== null,
    ahead,
    behind,
    todos,
  };
}

async function countTodos(git) {
  try {
    // -c prints "path:count" per file; sum them. Skip lockfiles and vendored trees.
    const out = await git(
      ['grep', '-I', '-c', '-E', '\\b(TODO|FIXME|HACK|XXX)\\b', '--', '.', ':!*.lock', ':!*lock.json', ':!vendor/', ':!node_modules/'],
      { timeoutMs: 5000 },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + (Number(line.slice(line.lastIndexOf(':') + 1)) || 0), 0);
  } catch {
    return 0; // exit code 1 = no matches; anything else we also treat as zero
  }
}

function bucketWeekly(dates, now) {
  const counts = new Array(WEEKS).fill(0);
  for (const d of dates) {
    const idx = Math.floor((now - d) / (7 * MS_DAY));
    if (idx >= 0 && idx < WEEKS) counts[WEEKS - 1 - idx] += 1;
  }
  return counts.map((count, i) => {
    const weekStart = new Date(now.getTime() - (WEEKS - 1 - i) * 7 * MS_DAY - 6 * MS_DAY);
    return { weekStart: weekStart.toISOString().slice(0, 10), count };
  });
}

// Turn git@github.com:owner/repo.git or https://github.com/owner/repo.git into a
// browsable URL; leave unknown hosts as-is.
export function normaliseRemote(url) {
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return { url, web: `https://${ssh[1]}/${ssh[2]}` };
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (https) return { url, web: `https://${https[1]}/${https[2]}` };
  return { url, web: null };
}

function run(dir, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, '--no-optional-locks', ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trimEnd());
      },
    );
  });
}
