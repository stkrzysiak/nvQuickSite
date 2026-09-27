// Minimal YAML front matter parser. Covers exactly what Backlog.md writes:
// scalars (optionally quoted), inline lists (`[]`, `[a, b]`) and block lists
// (`key:\n  - item`). It is not a general YAML parser and does not try to be.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontMatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: parseBlock(m[1]), body: m[2].replace(/^(\r?\n)+/, '') };
}

function parseBlock(src) {
  const data = {};
  const lines = src.split(/\r?\n/);
  let currentKey = null;

  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const listItem = /^\s+-\s*(.*)$/.exec(raw);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(scalar(listItem[1]));
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, rest] = kv;
    currentKey = key;
    const value = rest.trim();
    if (value === '') {
      data[key] = []; // block list (or empty) follows
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      data[key] = inner === '' ? [] : splitInline(inner).map(scalar);
    } else {
      data[key] = scalar(value);
    }
  }
  return data;
}

function splitInline(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

function scalar(v) {
  const s = v.trim();
  if (s === '') return '';
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}
