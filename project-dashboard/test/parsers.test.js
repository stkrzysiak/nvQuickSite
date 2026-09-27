import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter } from '../server/frontmatter.js';
import { summariseReadme } from '../server/stack.js';
import { normaliseRemote } from '../server/git.js';

test('front matter: scalars, quoted strings, inline and block lists', () => {
  const src = `---
id: TASK-1
title: 'Revoke and rotate 3 leaked credentials (OpenAI, GitHub PAT, Context7)'
status: To Do
assignee: []
created_date: '2026-08-13 16:09'
labels:
  - security
  - critical
dependencies: [TASK-2, "TASK-3"]
priority: high
ordinal: 1000
---

## Description
body text
`;
  const { data, body } = parseFrontMatter(src);
  assert.equal(data.id, 'TASK-1');
  assert.equal(data.title, 'Revoke and rotate 3 leaked credentials (OpenAI, GitHub PAT, Context7)');
  assert.equal(data.status, 'To Do');
  assert.deepEqual(data.assignee, []);
  assert.equal(data.created_date, '2026-08-13 16:09');
  assert.deepEqual(data.labels, ['security', 'critical']);
  assert.deepEqual(data.dependencies, ['TASK-2', 'TASK-3']);
  assert.equal(data.ordinal, 1000);
  assert.match(body, /^## Description/);
});

test('front matter: no fence returns the whole text as body', () => {
  const { data, body } = parseFrontMatter('just text');
  assert.deepEqual(data, {});
  assert.equal(body, 'just text');
});

test('readme summary skips badges, images and headings', () => {
  const text = `# Maplegator

[![ci](https://x/badge.svg)](https://x)
![logo](logo.png)

Tracks **maple syrup** listings across vendors and alerts on [price drops](https://x).
Second line of the same paragraph.

## Setup
More text.
`;
  const r = summariseReadme(text);
  assert.equal(r.title, 'Maplegator');
  assert.equal(r.summary, 'Tracks maple syrup listings across vendors and alerts on price drops. Second line of the same paragraph.');
});

test('readme summary handles a title-only readme', () => {
  assert.deepEqual(summariseReadme('# Only a title\n'), { title: 'Only a title', summary: null });
});

test('remote url normalisation', () => {
  assert.equal(normaliseRemote('git@github.com:stkrzysiak/plantgator.git').web, 'https://github.com/stkrzysiak/plantgator');
  assert.equal(normaliseRemote('https://github.com/stkrzysiak/plantgator.git').web, 'https://github.com/stkrzysiak/plantgator');
  assert.equal(normaliseRemote('https://github.com/stkrzysiak/plantgator').web, 'https://github.com/stkrzysiak/plantgator');
  assert.equal(normaliseRemote('/srv/git/plantgator.git').web, null);
});
