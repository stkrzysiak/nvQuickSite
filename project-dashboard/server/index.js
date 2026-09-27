// HTTP server: JSON API + static frontend. No dependencies beyond node:*.
//
// Env:
//   PROJECTS_ROOT   folder to scan (default ~/dev/personal, /projects in Docker)
//   DATA_DIR        where dashboard.json lives (default ./data)
//   PORT / HOST     default 8420 / 0.0.0.0
//   SCAN_INTERVAL   seconds between automatic rescans (default 300, 0 = off)
//   EXCLUDE         comma-separated folder names to skip

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Scanner } from './scanner.js';
import { Store, ValidationError, NotFoundError } from './store.js';
import { decorate, summarise } from './derive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const config = {
  root: expandHome(process.env.PROJECTS_ROOT || '~/dev/personal'),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  port: Number(process.env.PORT || 8420),
  host: process.env.HOST || '0.0.0.0',
  scanInterval: Number(process.env.SCAN_INTERVAL ?? 300),
  exclude: (process.env.EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export async function createApp(cfg = config) {
  const store = await new Store(cfg.dataDir).load();
  const scanner = new Scanner({ root: cfg.root, exclude: cfg.exclude });

  function view() {
    const now = new Date();
    const snap = scanner.get();
    const projects = snap.projects.map((p) => decorate({ ...p, meta: store.meta(p.id) }, now));
    return {
      root: cfg.root,
      scannedAt: snap.scannedAt,
      scanDurationMs: snap.durationMs,
      scanning: Boolean(scanner.inflight),
      errors: snap.errors,
      settings: store.settings(),
      summary: summarise(projects, now),
      projects,
    };
  }

  function findProject(id) {
    const p = scanner.get().projects.find((x) => x.id === id);
    if (!p) throw new NotFoundError('Unknown project');
    return p;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    if (pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const body = await route(method, pathname, req);
        if (body === undefined) return sendJson(res, 404, { error: 'Not found' });
        return sendJson(res, body === null ? 204 : 200, body);
      } catch (err) {
        const status = err.status ?? 500;
        if (status === 500) console.error(err);
        return sendJson(res, status, { error: err.message });
      }
    }

    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(pathname, res);
  }

  async function route(method, pathname, req) {
    if (method === 'GET' && pathname === '/api/health') {
      return { ok: true, scannedAt: scanner.get().scannedAt, projects: scanner.get().projects.length };
    }
    if (method === 'GET' && pathname === '/api/projects') return view();
    if (method === 'POST' && pathname === '/api/refresh') {
      await scanner.refresh();
      return view();
    }
    if (pathname === '/api/settings') {
      if (method === 'GET') return store.settings();
      if (method === 'PUT') return store.updateSettings(await readJson(req));
    }

    const m = /^\/api\/projects\/([^/]+)(?:\/(meta|questions)(?:\/([^/]+))?)?$/.exec(pathname);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const project = findProject(id);
    const sub = m[2];
    const qid = m[3];

    if (!sub && method === 'GET') return decorate({ ...project, meta: store.meta(id) }, new Date());
    if (sub === 'meta' && method === 'PUT') {
      const meta = await store.updateMeta(id, await readJson(req));
      return decorate({ ...project, meta }, new Date());
    }
    if (sub === 'questions' && !qid && method === 'POST') return store.addQuestion(id, await readJson(req));
    if (sub === 'questions' && qid && method === 'PATCH') return store.updateQuestion(id, qid, await readJson(req));
    if (sub === 'questions' && qid && method === 'DELETE') {
      await store.deleteQuestion(id, qid);
      return null;
    }
    return undefined;
  }

  async function serveStatic(pathname, res) {
    let rel = pathname === '/' || pathname === '/pm' || pathname === '/tech' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return sendJson(res, 403, { error: 'Forbidden' });
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': rel === '/index.html' ? 'no-cache' : 'max-age=300',
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  });

  let timer = null;
  async function start() {
    await scanner.refresh();
    if (cfg.scanInterval > 0) {
      timer = setInterval(() => scanner.refresh().catch((e) => console.error('scan failed', e)), cfg.scanInterval * 1000);
      timer.unref();
    }
    await new Promise((resolve) => server.listen(cfg.port, cfg.host, resolve));
    return server;
  }

  function stop() {
    if (timer) clearInterval(timer);
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, start, stop, scanner, store, view };
}

function sendJson(res, status, body) {
  if (status === 204) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp()
    .then(async (app) => {
      await app.start();
      console.log(`project-dashboard listening on http://${config.host}:${config.port}`);
      console.log(`scanning ${config.root} every ${config.scanInterval}s, data in ${config.dataDir}`);
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.stop().then(() => process.exit(0)));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
