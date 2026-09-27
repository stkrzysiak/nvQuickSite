/* Project dashboard frontend. Plain DOM, no build step. Two views over the
   same data: "pm" (project management) and "tech". All text from the API is
   inserted with textContent, never innerHTML. */
(() => {
  'use strict';

  const LIFECYCLE = [
    ['active', 'Active'],
    ['blocked', 'Blocked'],
    ['paused', 'Paused'],
    ['idea', 'Idea'],
    ['shipped', 'Shipped'],
    ['archived', 'Archived'],
  ];
  const LIFECYCLE_LABEL = Object.fromEntries(LIFECYCLE);
  const PRIORITIES = ['high', 'medium', 'low'];
  const HEALTH_ORDER = { healthy: 0, slowing: 1, stalled: 2, blocked: 3, dormant: 4, unknown: 5 };
  const POLL_MS = 60_000;

  const state = {
    view: null, // 'pm' | 'tech'
    data: null,
    search: '',
    healthFilter: 'all',
    lifecycleFilter: 'all',
    sort: { key: 'name', dir: 1 },
    open: null, // project id in the drawer
    editing: false,
    refreshing: false,
    showActivityTable: false,
  };

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
    append(el, children);
    return el;
  }
  const $ = (sel) => document.querySelector(sel);

  // ---------- icons (static markup, no user data) ----------
  const ICONS = {
    healthy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m5.2 8.2 1.9 1.9 3.8-4"/></svg>',
    slowing: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.3 1.6"/></svg>',
    stalled: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.5 8h5"/></svg>',
    blocked: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.6 1.8h4.8l3.8 3.8v4.8l-3.8 3.8H5.6L1.8 10.4V5.6z"/><path d="M8 5v3.4M8 11h.01"/></svg>',
    dormant: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="2.2 2.2"><circle cx="8" cy="8" r="6.2"/></svg>',
    unknown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3M8 11.2h.01"/></svg>',
    question: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-5l-3 2.5v-2.5h-3z"/></svg>',
  };

  // ---------- formatting ----------
  function relTime(iso) {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return '';
    const m = Math.round(ms / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const d = Math.round(hrs / 24);
    if (d < 14) return `${d}d ago`;
    const w = Math.round(d / 7);
    if (w < 9) return `${w}w ago`;
    const mo = Math.round(d / 30);
    if (mo < 18) return `${mo}mo ago`;
    return `${Math.round(d / 365)}y ago`;
  }
  function longDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function shortDate(ymd) {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function listNames(names, max = 3) {
    if (names.length <= max) return joinAnd(names);
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  }
  function joinAnd(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }
  const displayName = (p) => p.meta.displayName || p.stack?.readme?.title || p.name;
  const summaryOf = (p) => p.meta.summary || p.stack?.readme?.summary || p.stack?.packageDescription || '';

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
    return json;
  }

  async function load({ refresh = false } = {}) {
    state.refreshing = true;
    $('#main').classList.add('refreshing');
    try {
      state.data = refresh ? await api('POST', '/api/refresh') : await api('GET', '/api/projects');
      render();
    } catch (err) {
      toast(`Could not load projects: ${err.message}`);
    } finally {
      state.refreshing = false;
      $('#main').classList.remove('refreshing');
      renderScanStatus();
    }
  }

  // ---------- routing / theme ----------
  function initView() {
    const path = location.pathname.replace(/\/+$/, '');
    let view = path === '/pm' ? 'pm' : path === '/tech' ? 'tech' : null;
    if (!view) {
      view = localStorage.getItem('view') || 'tech';
      history.replaceState(null, '', `/${view}${location.search}`);
    }
    setView(view, { push: false });
  }
  function setView(view, { push = true } = {}) {
    state.view = view;
    localStorage.setItem('view', view);
    if (push) history.pushState(null, '', `/${view}`);
    for (const b of document.querySelectorAll('#view-switch button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    state.editing = false;
    render();
  }
  window.addEventListener('popstate', () => initView());

  function initTheme() {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  }
  function cycleTheme() {
    const cur = document.documentElement.dataset.theme || 'auto';
    const next = cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto';
    if (next === 'auto') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('theme');
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem('theme', next);
    }
    toast(`Theme: ${next}`);
  }

  // ---------- filtering / sorting ----------
  function visibleProjects() {
    const { data } = state;
    if (!data) return [];
    const q = state.search.trim().toLowerCase();
    return data.projects.filter((p) => {
      if (p.meta.hidden && state.lifecycleFilter !== 'hidden') return false;
      if (state.lifecycleFilter === 'hidden') return p.meta.hidden;
      if (state.lifecycleFilter !== 'all' && p.meta.status !== state.lifecycleFilter) return false;
      if (state.healthFilter === 'attention' && !['stalled', 'blocked'].includes(p.derived.health)) return false;
      if (state.healthFilter !== 'all' && state.healthFilter !== 'attention' && p.derived.health !== state.healthFilter) return false;
      if (q) {
        const hay = [p.name, displayName(p), summaryOf(p), p.git?.branch, ...(p.stack?.tags ?? []), ...(p.backlog?.tasks ?? []).map((t) => t.title)]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  const SORTERS = {
    name: (p) => displayName(p).toLowerCase(),
    health: (p) => HEALTH_ORDER[p.derived.health] ?? 9,
    activity: (p) => -(p.derived.lastActivity ? new Date(p.derived.lastActivity).getTime() : 0),
    commits7d: (p) => -(p.git?.commits7d ?? 0),
    dirty: (p) => -(p.git?.dirty ?? 0),
    sync: (p) => -((p.git?.ahead ?? 0) + (p.git?.behind ?? 0)),
    tasks: (p) => -p.derived.openTasks,
    priority: (p) => PRIORITIES.indexOf(p.meta.priority),
    questions: (p) => -p.derived.openQuestions,
  };
  function sorted(list) {
    const f = SORTERS[state.sort.key] ?? SORTERS.name;
    return [...list].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const c = x < y ? -1 : x > y ? 1 : SORTERS.name(a).localeCompare(SORTERS.name(b));
      return c * state.sort.dir;
    });
  }

  // ---------- render root ----------
  function render() {
    const { data } = state;
    if (!data) return;
    document.title = `${data.settings.title} · ${state.view === 'pm' ? 'Project management' : 'Technical'}`;
    $('#title').textContent = data.settings.title;
    $('#root').textContent = data.root;
    $('#root').title = data.root;
    renderScanStatus();
    renderFilters();
    const main = $('#main');
    main.replaceChildren(state.view === 'pm' ? renderPm() : renderTech());
    renderDrawer();
  }

  function renderScanStatus() {
    const el = $('#scan-status');
    const { data } = state;
    if (!data) return;
    el.textContent = state.refreshing ? 'Scanning…' : `Scanned ${relTime(data.scannedAt)}`;
    el.title = data.scannedAt ? `${longDate(data.scannedAt)} · ${data.scanDurationMs} ms` : '';
    $('#refresh').disabled = state.refreshing;
  }

  function renderFilters(force = false) {
    const el = $('#filters');
    if (!force && el.dataset.view === state.view) return;
    el.dataset.view = state.view;
    const pm = state.view === 'pm';
    const chips = [
      ['all', 'All'],
      ['attention', 'Needs attention'],
      ['healthy', 'Healthy'],
      ['slowing', 'Slowing'],
      ['stalled', 'Stalled'],
      ['blocked', 'Blocked'],
    ];
    el.replaceChildren(
      ...[
      h('input', {
        type: 'search',
        placeholder: pm ? 'Search projects, tasks…' : 'Search projects, branches, stack…',
        value: state.search,
        'aria-label': 'Search',
        oninput: (e) => {
          state.search = e.target.value;
          renderMainOnly();
        },
      }),
      h(
        'div',
        { class: 'chips', role: 'group', 'aria-label': 'Health' },
        chips.map(([key, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip',
              'aria-pressed': String(state.healthFilter === key),
              onclick: () => {
                state.healthFilter = key;
                renderFilters(true);
                renderMainOnly();
              },
            },
            label,
          ),
        ),
      ),
      h(
        'select',
        {
          'aria-label': 'Lifecycle',
          onchange: (e) => {
            state.lifecycleFilter = e.target.value;
            renderMainOnly();
          },
        },
        h('option', { value: 'all', selected: state.lifecycleFilter === 'all' }, 'Any status'),
        LIFECYCLE.map(([k, l]) => h('option', { value: k, selected: state.lifecycleFilter === k }, l)),
        h('option', { value: 'hidden', selected: state.lifecycleFilter === 'hidden' }, 'Hidden'),
      ),
      pm
        ? h(
            'select',
            {
              'aria-label': 'Sort',
              onchange: (e) => {
                state.sort = { key: e.target.value, dir: 1 };
                renderMainOnly();
              },
            },
            [
              ['priority', 'Sort: priority'],
              ['health', 'Sort: needs attention'],
              ['activity', 'Sort: recent activity'],
              ['name', 'Sort: name'],
            ].map(([k, l]) => h('option', { value: k, selected: state.sort.key === k }, l)),
          )
        : null,
      ].filter(Boolean),
    );
  }
  function renderMainOnly() {
    $('#main').replaceChildren(state.view === 'pm' ? renderPm() : renderTech());
  }

  // ---------- shared pieces ----------
  function healthPill(p, { withDays = false } = {}) {
    const d = p.derived;
    const el = h('span', { class: `health ${d.healthTone}`, title: healthTitle(p) });
    el.innerHTML = ICONS[d.health] ?? ICONS.unknown;
    el.append(document.createTextNode(d.healthLabel));
    if (withDays && d.daysSinceActivity !== null && d.health !== 'blocked') {
      el.append(h('span', { class: 'muted' }, ` · ${d.daysSinceActivity === 0 ? 'today' : `${d.daysSinceActivity}d`}`));
    }
    return el;
  }
  function healthTitle(p) {
    const d = p.derived;
    switch (d.health) {
      case 'healthy': return 'Activity within the last 7 days';
      case 'slowing': return 'No activity for 8–30 days';
      case 'stalled': return 'No activity for more than 30 days';
      case 'blocked': return p.meta.blockers.length ? `Blocked: ${p.meta.blockers.join('; ')}` : 'Marked as blocked';
      case 'dormant': return `Marked ${LIFECYCLE_LABEL[p.meta.status] ?? p.meta.status}; not expected to move`;
      default: return 'No git history or backlog found';
    }
  }
  function meter(progress, { label = true } = {}) {
    if (!progress) return null;
    const pct = Math.round(progress.ratio * 100);
    return h(
      'div',
      { class: 'meter', role: 'img', 'aria-label': `${progress.done} of ${progress.total} tasks done` },
      h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${pct}%` })),
      label ? h('span', { class: 'num' }, `${progress.done}/${progress.total}`) : null,
    );
  }
  function tile({ label, value, delta, deltaTone, sub }) {
    return h(
      'div',
      { class: 'tile' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value),
      delta ? h('div', { class: `delta ${deltaTone ?? ''}` }, delta) : null,
      sub ? h('div', { class: 'sub', title: sub }, sub) : null,
    );
  }
  function deltaText(now, prev, noun) {
    if (prev === now) return `same as last week`;
    const diff = now - prev;
    return `${diff > 0 ? '+' : ''}${diff} vs last week`;
  }
  function priorityTag(p) {
    return h('span', { class: `tag prio-${p.meta.priority}` }, `${p.meta.priority} priority`);
  }
  function questionBadge(p) {
    if (!p.derived.openQuestions) return null;
    const el = h('span', { class: 'badge-q', title: 'Open questions' });
    el.innerHTML = ICONS.question;
    el.append(document.createTextNode(String(p.derived.openQuestions)));
    return el;
  }

  // ---------- PM view ----------
  function renderPm() {
    const { data } = state;
    const list = sorted(visibleProjects());
    const s = data.summary;
    const frag = document.createDocumentFragment();

    frag.append(
      h(
        'div',
        { class: 'kpis' },
        tile({ label: 'Projects moving this week', value: s.activeProjects, sub: s.projectsTouched.length ? listNames(s.projectsTouched) : 'Nothing touched in 7 days' }),
        tile({ label: 'Tasks in progress', value: s.inProgress, sub: `${s.withBacklog} of ${s.projects} projects have a backlog` }),
        tile({ label: 'Tasks finished this week', value: s.doneThisWeek, delta: deltaText(s.doneThisWeek, s.doneLastWeek), deltaTone: s.doneThisWeek > s.doneLastWeek ? 'up' : s.doneThisWeek < s.doneLastWeek ? 'down' : '' }),
        tile({ label: 'Need attention', value: s.needsAttention, sub: s.needsAttentionNames.length ? listNames(s.needsAttentionNames) : 'Everything is moving', deltaTone: '' }),
      ),
      renderDigest(s),
    );

    if (!list.length) {
      frag.append(h('div', { class: 'empty' }, 'No projects match these filters.'));
      return frag;
    }

    const groups = new Map(LIFECYCLE.map(([k]) => [k, []]));
    for (const p of list) (groups.get(p.meta.status) ?? groups.get('active')).push(p);

    frag.append(h('div', { class: 'section-title' }, 'Projects by status'));
    const board = h('div', { class: 'board' });
    for (const [key, label] of LIFECYCLE) {
      const items = groups.get(key);
      if (!items.length && key !== 'active') continue;
      board.append(
        h(
          'section',
          { class: 'column', 'aria-label': label },
          h('div', { class: 'column-head' }, h('h3', null, label), h('span', { class: 'count' }, plural(items.length, 'project'))),
          items.length ? items.map(pmCard) : h('div', { class: 'muted', style: 'padding:6px 2px' }, 'Nothing here yet.'),
        ),
      );
    }
    frag.append(board);
    return frag;
  }

  function renderDigest(s) {
    const parts = [];
    parts.push(
      h('span', null, 'This week: '),
      h('strong', null, plural(s.commits7d, 'code change')),
      s.projectsTouched.length ? ` across ${listNames(s.projectsTouched)}` : '',
      s.commitsPrev7d !== undefined ? ` (${s.commitsPrev7d} the week before)` : '',
      ', ',
      h('strong', null, plural(s.doneThisWeek, 'task')),
      ' finished, ',
      h('strong', null, String(s.inProgress)),
      ' in progress. ',
    );
    if (s.needsAttention) {
      parts.push(h('strong', null, plural(s.needsAttention, 'project')), ` need${s.needsAttention === 1 ? 's' : ''} attention: ${listNames(s.needsAttentionNames, 5)}. `);
    }
    if (s.openQuestions) parts.push(h('strong', null, plural(s.openQuestions, 'open question')), ' waiting for an answer.');
    return h('p', { class: 'digest' }, ...parts);
  }

  function pmCard(p) {
    const d = p.derived;
    const summary = summaryOf(p);
    const next = d.nextUp.slice(0, 3);
    return h(
      'button',
      { type: 'button', class: 'card', onclick: () => openDrawer(p.id) },
      h('div', { class: 'title-row' }, h('span', { class: 'title' }, displayName(p)), healthPill(p)),
      h('div', { class: `summary ${summary ? '' : 'placeholder'}` }, summary || 'No description yet — open to add one.'),
      meter(d.progress),
      h(
        'div',
        { class: 'meta-row' },
        priorityTag(p),
        h('span', null, `Last activity ${relTime(d.lastActivity)}`),
        p.meta.targetDate ? h('span', null, `Target ${shortDate(p.meta.targetDate)}`) : null,
        questionBadge(p),
      ),
      p.meta.blockers.length ? h('div', { class: 'blockers' }, `Blocked: ${p.meta.blockers[0]}${p.meta.blockers.length > 1 ? ` (+${p.meta.blockers.length - 1})` : ''}`) : null,
      p.meta.nextMilestone ? h('div', { class: 'next' }, 'Next milestone: ', h('strong', null, p.meta.nextMilestone)) : null,
      next.length
        ? h('div', { class: 'next' }, h('ul', null, next.map((t) => h('li', null, t.status !== p.backlog.statuses[0] ? h('strong', null, 'Now: ') : '', t.title))))
        : null,
    );
  }

  // ---------- Tech view ----------
  const TECH_COLUMNS = [
    { key: 'name', label: 'Project' },
    { key: 'health', label: 'Health' },
    { key: null, label: 'Branch' },
    { key: 'dirty', label: 'Changes', title: 'Uncommitted files' },
    { key: 'sync', label: 'Sync', title: 'Ahead / behind upstream' },
    { key: 'activity', label: 'Last commit' },
    { key: 'commits7d', label: '7d', title: 'Commits in the last 7 days' },
    { key: null, label: '12 weeks' },
    { key: 'tasks', label: 'Tasks', title: 'Open tasks (in progress)' },
    { key: null, label: 'Stack' },
    { key: 'questions', label: '?', title: 'Open questions from the PM view' },
  ];

  function renderTech() {
    const { data } = state;
    const s = data.summary;
    const list = sorted(visibleProjects());
    const frag = document.createDocumentFragment();
    frag.append(
      h(
        'div',
        { class: 'kpis' },
        tile({ label: 'Repositories', value: s.repos, sub: `${s.projects} folders scanned, ${s.withBacklog} with a backlog` }),
        tile({ label: 'Uncommitted changes', value: s.dirtyRepos, sub: s.dirtyRepos ? 'repos with a dirty working tree' : 'all working trees clean' }),
        tile({ label: 'Unpushed commits', value: s.unpushed, sub: 'ahead of upstream, all repos' }),
        tile({ label: 'Open questions', value: s.openQuestions, sub: s.openQuestions ? `from ${data.settings.pmName}` : 'nothing waiting on you' }),
      ),
    );
    if (data.errors?.length) {
      frag.append(h('p', { class: 'digest' }, h('strong', null, 'Scan warnings: '), data.errors.map((e) => `${e.project ? `${e.project}: ` : ''}${e.message}`).join(' · ')));
    }
    if (!list.length) {
      frag.append(h('div', { class: 'empty' }, 'No projects match these filters.'));
      return frag;
    }
    const thead = h(
      'tr',
      null,
      TECH_COLUMNS.map((c) =>
        h(
          'th',
          { scope: 'col', title: c.title ?? null },
          c.key
            ? h(
                'button',
                {
                  type: 'button',
                  'aria-sort': state.sort.key === c.key ? (state.sort.dir === 1 ? 'ascending' : 'descending') : null,
                  onclick: () => {
                    state.sort = state.sort.key === c.key ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: 1 };
                    renderMainOnly();
                  },
                },
                c.label,
                state.sort.key === c.key ? (state.sort.dir === 1 ? '↑' : '↓') : '',
              )
            : c.label,
        ),
      ),
    );
    const rows = list.map((p) => techRow(p));
    frag.append(h('div', { class: 'section-title' }, plural(list.length, 'project')), h('div', { class: 'table-wrap' }, h('table', { class: 'tech' }, h('thead', null, thead), h('tbody', null, rows))));
    return frag;
  }

  function techRow(p) {
    const g = p.git;
    const d = p.derived;
    const open = () => openDrawer(p.id);
    const sync = !g
      ? h('span', { class: 'muted' }, '—')
      : !g.hasUpstream
        ? h('span', { class: 'muted', title: 'No upstream branch' }, g.remote ? 'no upstream' : 'no remote')
        : g.ahead === 0 && g.behind === 0
          ? h('span', { class: 'ok' }, 'in sync')
          : h('span', { class: 'warn num' }, `${g.ahead ? `↑${g.ahead} ` : ''}${g.behind ? `↓${g.behind}` : ''}`.trim());
    return h(
      'tr',
      { tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
      h('td', { class: 'name' }, displayName(p), h('span', { class: 'sub' }, p.name !== displayName(p) ? `${p.name} · ` : '', summaryOf(p) || (g ? '' : 'not a git repository'))),
      h('td', null, healthPill(p, { withDays: true })),
      h('td', { class: 'mono' }, g ? g.branch : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'num' }, g ? (g.dirty ? h('span', { class: 'warn' }, `${g.dirty} modified`) : h('span', { class: 'ok' }, 'clean')) : ''),
      h('td', null, sync),
      h(
        'td',
        null,
        g?.lastCommit
          ? [h('span', { class: 'nowrap' }, relTime(g.lastCommit.date)), h('span', { class: 'muted' }, ' · '), h('span', { class: 'ink2', title: g.lastCommit.subject }, truncate(g.lastCommit.subject, 48))]
          : h('span', { class: 'muted' }, '—'),
      ),
      h('td', { class: 'num' }, g ? g.commits7d : ''),
      h('td', null, g ? sparkline(g.weekly, { width: 120, height: 28 }) : ''),
      h('td', { class: 'num' }, p.backlog ? `${d.openTasks}${d.inProgress ? ` (${d.inProgress})` : ''}` : h('span', { class: 'muted' }, '—')),
      h('td', null, h('div', { class: 'tags' }, (p.stack?.tags ?? []).slice(0, 5).map((t) => h('span', { class: 'tag' }, t)))),
      h('td', null, questionBadge(p)),
    );
  }
  const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

  // Single-series sparkline: 2px line, 10% area wash, end marker with a
  // surface ring, hairline baseline. Hover shows week + count.
  function sparkline(weekly, { width, height, interactive = false }) {
    const pad = 4;
    const max = Math.max(1, ...weekly.map((w) => w.count));
    const n = weekly.length;
    const x = (i) => pad + (i * (width - pad * 2)) / (n - 1);
    const y = (v) => height - pad - (v / max) * (height - pad * 2);
    const pts = weekly.map((w, i) => [x(i), y(w.count)]);
    const path = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const area = `${path} L${x(n - 1).toFixed(1)},${(height - pad).toFixed(1)} L${x(0).toFixed(1)},${(height - pad).toFixed(1)} Z`;
    const total = weekly.reduce((a, w) => a + w.count, 0);
    const el = svg('svg', {
      class: 'spark',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `${total} commits over the last ${n} weeks`,
    });
    el.append(
      svg('line', { class: 'baseline', x1: pad, x2: width - pad, y1: height - pad + 0.5, y2: height - pad + 0.5 }),
      svg('path', { class: 'area', d: area }),
      svg('path', { class: 'line', d: path }),
      svg('circle', { class: 'dot', cx: pts[n - 1][0], cy: pts[n - 1][1], r: 3 }),
    );
    if (!interactive) return el;

    const wrap = h('div', { class: 'chart' });
    const tip = h('div', { class: 'tip hidden' });
    const hover = svg('circle', { class: 'hover-dot hidden', r: 4 });
    el.append(hover);
    const slot = (width - pad * 2) / (n - 1);
    weekly.forEach((w, i) => {
      const hit = svg('rect', { class: 'hit', x: x(i) - slot / 2, y: 0, width: slot, height });
      const show = () => {
        hover.setAttribute('cx', pts[i][0]);
        hover.setAttribute('cy', pts[i][1]);
        hover.classList.remove('hidden');
        tip.replaceChildren(h('strong', null, plural(w.count, 'commit')), ` · week of ${shortDate(w.weekStart)}`);
        tip.classList.remove('hidden');
        const box = el.getBoundingClientRect();
        const left = (pts[i][0] / width) * box.width;
        tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
        tip.style.top = `${(pts[i][1] / height) * box.height}px`;
      };
      const hide = () => {
        hover.classList.add('hidden');
        tip.classList.add('hidden');
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerleave', hide);
      hit.setAttribute('tabindex', '0');
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hide);
      el.append(hit);
    });
    wrap.append(el, tip);
    return wrap;
  }

  // ---------- Drawer ----------
  function openDrawer(id) {
    state.open = id;
    state.editing = false;
    state.showActivityTable = false;
    renderDrawer();
  }
  function closeDrawer() {
    state.open = null;
    state.editing = false;
    renderDrawer();
  }
  function currentProject() {
    return state.data?.projects.find((p) => p.id === state.open) ?? null;
  }
  function renderDrawer() {
    const overlay = $('#overlay');
    const p = currentProject();
    if (!p) {
      overlay.replaceChildren();
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    const body = state.view === 'pm' ? pmDrawer(p) : techDrawer(p);
    const drawer = h(
      'aside',
      { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': displayName(p) },
      h(
        'div',
        { class: 'drawer-head' },
        h(
          'div',
          { class: 'grow' },
          h('h2', { tabindex: '-1' }, displayName(p)),
          h(
            'div',
            { class: 'sub' },
            healthPill(p, { withDays: true }),
            h('span', { class: 'tag' }, LIFECYCLE_LABEL[p.meta.status]),
            priorityTag(p),
            p.git?.remote?.web ? h('a', { href: p.git.remote.web, target: '_blank', rel: 'noopener' }, 'Open repository ↗') : null,
            p.meta.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, `${l.label} ↗`)),
          ),
        ),
        h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Close', onclick: closeDrawer }, '✕'),
      ),
      h('div', { class: 'drawer-body' }, body),
    );
    overlay.replaceChildren(h('div', { class: 'scrim', onclick: closeDrawer }), drawer);
    drawer.querySelector('h2')?.focus?.();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#popover').children.length) $('#popover').replaceChildren();
      else if (state.open) closeDrawer();
    }
  });

  // ----- PM drawer -----
  function pmDrawer(p) {
    const d = p.derived;
    const me = state.data.settings.pmName;
    const panels = [];

    panels.push(
      h(
        'section',
        { class: 'panel' },
        h('h3', null, 'Summary', state.editing ? null : h('button', { type: 'button', class: 'btn small', onclick: () => { state.editing = true; renderDrawer(); } }, 'Edit')),
        state.editing ? metaForm(p) : summaryBlock(p),
      ),
    );

    panels.push(
      h(
        'section',
        { class: 'panel' },
        h('h3', null, 'Progress'),
        d.progress
          ? h('div', { class: 'progress-big' }, h('span', { class: 'value' }, `${Math.round(d.progress.ratio * 100)}%`), meter(d.progress))
          : h('p', { class: 'muted', style: 'margin:0' }, 'This project has no task backlog yet, so progress is measured by activity only.'),
        h(
          'dl',
          { class: 'kv', style: 'margin-top:12px' },
          h('dt', null, 'Last activity'),
          h('dd', null, d.lastActivity ? `${relTime(d.lastActivity)} (${longDate(d.lastActivity)})` : 'none recorded'),
          h('dt', null, 'This week'),
          h('dd', null, `${plural(p.git?.commits7d ?? 0, 'code change')}, ${plural(d.doneThisWeek, 'task')} finished`),
          h('dt', null, 'Open work'),
          h('dd', null, p.backlog ? `${plural(d.openTasks, 'open task')}, ${d.inProgress} in progress` : '—'),
          p.meta.targetDate ? [h('dt', null, 'Target date'), h('dd', null, `${shortDate(p.meta.targetDate)} (${daysUntil(p.meta.targetDate)})`)] : null,
        ),
      ),
    );

    if (p.backlog) {
      const next = d.nextUp;
      panels.push(
        h(
          'section',
          { class: 'panel' },
          h('h3', null, "What's next", h('span', { class: 'muted' }, 'from the backlog')),
          next.length ? next.map((t) => taskRow(t, p)) : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing open. Everything in the backlog is done.'),
        ),
      );
    }

    if (p.meta.blockers.length) {
      panels.push(h('section', { class: 'panel' }, h('h3', null, 'Blockers'), h('ul', { class: 'blocker-list' }, p.meta.blockers.map((b) => h('li', null, b)))));
    }

    panels.push(questionsPanel(p, { asker: 'pm', me }));

    if (p.meta.notes) panels.push(h('section', { class: 'panel' }, h('h3', null, 'Notes'), h('div', { class: 'summary-text' }, p.meta.notes)));
    return panels;
  }

  function daysUntil(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const diff = Math.round((new Date(y, m - 1, d) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
    if (diff === 0) return 'today';
    return diff > 0 ? `in ${plural(diff, 'day')}` : `${plural(-diff, 'day')} overdue`;
  }

  function summaryBlock(p) {
    const summary = summaryOf(p);
    return [
      summary ? h('div', { class: 'summary-text' }, summary) : h('p', { class: 'muted', style: 'margin:0' }, 'No description yet. Use Edit to explain what this project is for in plain language.'),
      p.meta.summary ? null : summary ? h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12px' }, 'Taken from the project README.') : null,
      h(
        'dl',
        { class: 'kv', style: 'margin-top:12px' },
        h('dt', null, 'Status'),
        h('dd', null, LIFECYCLE_LABEL[p.meta.status]),
        h('dt', null, 'Priority'),
        h('dd', null, p.meta.priority),
        p.meta.owner ? [h('dt', null, 'Owner'), h('dd', null, p.meta.owner)] : null,
        p.meta.nextMilestone ? [h('dt', null, 'Next milestone'), h('dd', null, p.meta.nextMilestone)] : null,
        h('dt', null, 'Folder'),
        h('dd', { class: 'mono' }, p.name),
      ),
    ];
  }

  function metaForm(p) {
    const m = p.meta;
    const f = {};
    let err;
    const field = (label, el, cls = '') => h('label', { class: cls }, label, el);
    const form = h(
      'form',
      {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          const patch = {
            displayName: f.displayName.value,
            summary: f.summary.value,
            status: f.status.value,
            priority: f.priority.value,
            owner: f.owner.value,
            targetDate: f.targetDate.value,
            nextMilestone: f.nextMilestone.value,
            blockers: f.blockers.value.split('\n'),
            notes: f.notes.value,
            links: f.links.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const [label, url] = l.includes('|') ? l.split('|').map((s) => s.trim()) : [l, l];
                return { label, url };
              }),
            hidden: f.hidden.checked,
          };
          err.textContent = '';
          try {
            const updated = await api('PUT', `/api/projects/${encodeURIComponent(p.id)}/meta`, patch);
            replaceProject(updated);
            state.editing = false;
            toast('Saved');
            render();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      },
      field('Display name', (f.displayName = h('input', { value: m.displayName, placeholder: p.stack?.readme?.title || p.name }))),
      field('Owner', (f.owner = h('input', { value: m.owner, placeholder: 'who is driving this' }))),
      field(
        'Status',
        (f.status = h('select', null, LIFECYCLE.map(([k, l]) => h('option', { value: k, selected: m.status === k }, l)))),
      ),
      field(
        'Priority',
        (f.priority = h('select', null, PRIORITIES.map((k) => h('option', { value: k, selected: m.priority === k }, k)))),
      ),
      field('Target date', (f.targetDate = h('input', { type: 'date', value: m.targetDate }))),
      field('Next milestone', (f.nextMilestone = h('input', { value: m.nextMilestone, placeholder: 'e.g. first demo to a real user' }))),
      field('What is this project, in plain language?', (f.summary = h('textarea', { placeholder: p.stack?.readme?.summary || 'One or two sentences a non-engineer would understand.' }, m.summary)), 'full'),
      field('Blockers (one per line)', (f.blockers = h('textarea', { placeholder: 'Anything stopping progress. Leave empty when unblocked.' }, m.blockers.join('\n'))), 'full'),
      field('Links (one per line, "Label | https://…")', (f.links = h('textarea', null, m.links.map((l) => `${l.label} | ${l.url}`).join('\n'))), 'full'),
      field('Notes', (f.notes = h('textarea', null, m.notes)), 'full'),
      h('label', { class: 'check full' }, (f.hidden = h('input', { type: 'checkbox', checked: m.hidden })), 'Hide this project from the dashboard'),
      h(
        'div',
        { class: 'actions' },
        (err = h('span', { class: 'form-error' })),
        h('button', { type: 'button', class: 'btn', onclick: () => { state.editing = false; renderDrawer(); } }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
      ),
    );
    return form;
  }

  function replaceProject(updated) {
    const i = state.data.projects.findIndex((p) => p.id === updated.id);
    if (i >= 0) state.data.projects[i] = updated;
    // Summary tiles derive from the server; refetch quietly so KPIs stay honest.
    api('GET', '/api/projects').then((d) => { state.data = d; if (!state.editing) render(); }).catch(() => {});
  }

  function taskRow(t, p) {
    const isDone = t.status === p.backlog.doneStatus;
    const inProg = !isDone && t.status !== p.backlog.statuses[0];
    return h(
      'div',
      { class: 'task' },
      h('span', { class: 'id' }, t.id),
      h('div', null, h('div', { class: 't' }, t.title), t.description ? h('div', { class: 'd' }, truncate(t.description, 180)) : null),
      h(
        'div',
        { class: 'right' },
        inProg ? h('span', { class: 'tag accent' }, t.status) : null,
        t.priority ? h('span', { class: `tag prio-${t.priority}` }, t.priority) : null,
        t.acceptance.total ? h('span', { class: 'num', title: 'Acceptance criteria met' }, `${t.acceptance.done}/${t.acceptance.total}`) : null,
        h('span', { title: longDate(t.updatedDate) }, relTime(t.updatedDate)),
      ),
    );
  }

  function questionsPanel(p, { asker, me }) {
    const { techName, pmName } = state.data.settings;
    const nameOf = (from) => (from === 'tech' ? techName : pmName);
    const qs = [...p.meta.questions].sort((a, b) => Number(a.resolved) - Number(b.resolved) || (a.createdAt < b.createdAt ? 1 : -1));
    const open = qs.filter((q) => !q.resolved).length;
    const list = qs.length
      ? qs.map((q) =>
          h(
            'div',
            { class: `q ${q.resolved ? 'resolved' : ''}` },
            h('div', { class: 'who' }, h('span', { class: 'from' }, nameOf(q.from)), h('span', { title: longDate(q.createdAt) }, relTime(q.createdAt)), q.resolved ? h('span', { class: 'tag' }, 'resolved') : null),
            h('div', { class: 'text' }, q.text),
            q.answer
              ? h('div', { class: 'answer' }, h('div', { class: 'who' }, h('span', { class: 'from' }, nameOf(q.from === 'tech' ? 'pm' : 'tech')), h('span', null, relTime(q.answeredAt))), q.answer)
              : q.from !== asker && !q.resolved
                ? answerForm(p, q)
                : null,
            h(
              'div',
              { class: 'actions' },
              h('button', { type: 'button', class: 'btn small ghost', onclick: () => patchQuestion(p, q.id, { resolved: !q.resolved }) }, q.resolved ? 'Reopen' : 'Mark resolved'),
              q.from === asker ? h('button', { type: 'button', class: 'btn small ghost danger', onclick: () => deleteQuestion(p, q.id) }, 'Delete') : null,
            ),
          ),
        )
      : h('p', { class: 'muted', style: 'margin:0' }, asker === 'pm' ? `Ask ${techName} anything about this project. Questions show up in the technical view.` : `No questions from ${pmName} yet. You can also leave a note for them here.`);

    const ta = h('textarea', { placeholder: asker === 'pm' ? `Question for ${techName}…` : `Note for ${pmName}…`, 'aria-label': 'New question' });
    const ask = h(
      'form',
      {
        class: 'ask',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!ta.value.trim()) return;
          try {
            await api('POST', `/api/projects/${encodeURIComponent(p.id)}/questions`, { from: asker, text: ta.value });
            await reloadProject(p.id);
            toast('Sent');
          } catch (ex) {
            toast(ex.message);
          }
        },
      },
      ta,
      h('button', { type: 'submit', class: 'btn primary' }, asker === 'pm' ? 'Ask' : 'Post'),
    );
    return h('section', { class: 'panel' }, h('h3', null, 'Questions & notes', open ? h('span', { class: 'muted' }, `${open} open`) : null), list, ask);
  }
  function answerForm(p, q) {
    const ta = h('textarea', { placeholder: 'Answer…', 'aria-label': 'Answer' });
    return h(
      'form',
      {
        class: 'answer-form',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!ta.value.trim()) return;
          await patchQuestion(p, q.id, { answer: ta.value, resolved: true });
        },
      },
      ta,
      h('button', { type: 'submit', class: 'btn small' }, 'Answer'),
    );
  }
  async function patchQuestion(p, qid, patch) {
    try {
      await api('PATCH', `/api/projects/${encodeURIComponent(p.id)}/questions/${qid}`, patch);
      await reloadProject(p.id);
    } catch (ex) {
      toast(ex.message);
    }
  }
  async function deleteQuestion(p, qid) {
    if (!confirm('Delete this question?')) return;
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(p.id)}/questions/${qid}`);
      await reloadProject(p.id);
    } catch (ex) {
      toast(ex.message);
    }
  }
  async function reloadProject(id) {
    const updated = await api('GET', `/api/projects/${encodeURIComponent(id)}`);
    replaceProject(updated);
    render();
  }

  // ----- Tech drawer -----
  function techDrawer(p) {
    const g = p.git;
    const s = p.stack ?? {};
    const panels = [];

    panels.push(
      h(
        'section',
        { class: 'panel' },
        h('h3', null, 'Repository'),
        g
          ? h(
              'dl',
              { class: 'kv' },
              h('dt', null, 'Path'),
              h('dd', { class: 'mono' }, p.path),
              h('dt', null, 'Branch'),
              h('dd', { class: 'mono' }, `${g.branch} @ ${g.head ?? '?'}`),
              h('dt', null, 'Remote'),
              h('dd', { class: 'mono' }, g.remote ? g.remote.url : h('span', { class: 'muted' }, 'none')),
              h('dt', null, 'Working tree'),
              h('dd', null, g.dirty ? [h('span', { class: 'warn', style: 'color:var(--serious-ink)' }, `${plural(g.dirty, 'modified file')}`), g.stashes ? `, ${plural(g.stashes, 'stash', 'stashes')}` : ''] : 'clean'),
              h('dt', null, 'Upstream'),
              h('dd', null, !g.hasUpstream ? 'no upstream branch' : g.ahead || g.behind ? `${g.ahead} ahead, ${g.behind} behind` : 'in sync'),
              h('dt', null, 'History'),
              h('dd', null, `${g.totalCommits ?? '?'} commits total · ${g.commits30d} in 30 days · ${g.todos} TODO/FIXME markers`),
            )
          : h('p', { class: 'muted', style: 'margin:0' }, `${p.path} is not a git repository.`),
      ),
    );

    if (g) {
      const weeks = g.weekly;
      panels.push(
        h(
          'section',
          { class: 'panel' },
          h(
            'h3',
            null,
            'Commits per week',
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => { state.showActivityTable = !state.showActivityTable; renderDrawer(); } }, state.showActivityTable ? 'Show chart' : 'Show table'),
          ),
          state.showActivityTable
            ? h(
                'table',
                { class: 'small-table' },
                h('thead', null, h('tr', null, h('th', null, 'Week of'), h('th', null, 'Commits'))),
                h('tbody', null, weeks.map((w) => h('tr', null, h('td', null, shortDate(w.weekStart)), h('td', { class: 'num' }, w.count)))),
              )
            : sparkline(weeks, { width: 640, height: 72, interactive: true }),
          h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, `${weeks.reduce((a, w) => a + w.count, 0)} commits in the last ${weeks.length} weeks · ${g.commits7d} this week`),
        ),
      );

      if (g.dirtyFiles.length) {
        panels.push(
          h('section', { class: 'panel' }, h('h3', null, 'Uncommitted changes'), h('ul', { class: 'list mono' }, g.dirtyFiles.map((f) => h('li', null, f)))),
        );
      }

      panels.push(
        h(
          'section',
          { class: 'panel' },
          h('h3', null, 'Recent commits'),
          h(
            'ul',
            { class: 'list' },
            g.commits.slice(0, 15).map((c) =>
              h(
                'li',
                { class: 'commit' },
                g.remote?.web ? h('a', { class: 'sha', href: `${g.remote.web}/commit/${c.sha}`, target: '_blank', rel: 'noopener' }, c.short) : h('span', { class: 'sha' }, c.short),
                h('span', null, c.subject),
                h('span', { class: 'when', title: `${c.author} · ${longDate(c.date)}` }, relTime(c.date)),
              ),
            ),
          ),
        ),
      );
    }

    if (p.backlog) {
      const b = p.backlog;
      const groups = b.statuses.map((st) => [st, b.tasks.filter((t) => t.status === st)]);
      const other = b.tasks.filter((t) => !b.statuses.includes(t.status));
      if (other.length) groups.push(['Other', other]);
      panels.push(
        h(
          'section',
          { class: 'panel task-group' },
          h('h3', null, 'Backlog', h('span', { class: 'muted' }, `${b.counts.done}/${b.counts.total} done`)),
          groups
            .filter(([, ts]) => ts.length)
            .map(([st, ts]) => {
              const isDone = st === b.doneStatus;
              const shown = isDone ? ts.sort((a, c) => (a.updatedDate < c.updatedDate ? 1 : -1)).slice(0, 8) : ts.sort((a, c) => (a.ordinal ?? 0) - (c.ordinal ?? 0));
              return [h('h4', null, `${st} (${ts.length})`), shown.map((t) => taskRow(t, p)), isDone && ts.length > 8 ? h('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 0' }, `${ts.length - 8} older done tasks not shown`) : null];
            }),
        ),
      );
    }

    panels.push(questionsPanel(p, { asker: 'tech' }));

    const stackBits = [];
    if (s.tags?.length) stackBits.push(h('dt', null, 'Detected'), h('dd', null, h('div', { class: 'tags' }, s.tags.map((t) => h('span', { class: 'tag' }, t)))));
    if (s.packageName) stackBits.push(h('dt', null, 'Package'), h('dd', { class: 'mono' }, s.packageName));
    if (s.makeTargets?.length) stackBits.push(h('dt', null, 'make targets'), h('dd', { class: 'mono' }, s.makeTargets.join(', ')));
    if (s.scripts?.length) stackBits.push(h('dt', null, 'npm scripts'), h('dd', { class: 'mono' }, s.scripts.join(', ')));
    if (s.workflows?.length) stackBits.push(h('dt', null, 'Workflows'), h('dd', { class: 'mono' }, s.workflows.join(', ')));
    panels.push(
      h(
        'section',
        { class: 'panel' },
        h('h3', null, 'Stack & tooling'),
        stackBits.length ? h('dl', { class: 'kv' }, stackBits) : h('p', { class: 'muted', style: 'margin:0' }, 'No recognisable marker files at the project root.'),
      ),
    );

    panels.push(
      h(
        'section',
        { class: 'panel' },
        h('h3', null, 'Project management', h('button', { type: 'button', class: 'btn small', onclick: () => { setView('pm'); state.editing = true; renderDrawer(); } }, 'Edit in PM view')),
        summaryBlock(p),
        p.meta.blockers.length ? h('ul', { class: 'blocker-list', style: 'margin-top:10px' }, p.meta.blockers.map((b) => h('li', null, b))) : null,
      ),
    );
    return panels;
  }

  // ---------- settings popover ----------
  function toggleSettings() {
    const pop = $('#popover');
    if (pop.children.length) return pop.replaceChildren();
    const s = state.data.settings;
    const f = {};
    pop.replaceChildren(
      h(
        'form',
        {
          class: 'popover form',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              state.data.settings = await api('PUT', '/api/settings', { title: f.title.value, techName: f.techName.value, pmName: f.pmName.value });
              pop.replaceChildren();
              render();
              toast('Settings saved');
            } catch (ex) {
              toast(ex.message);
            }
          },
        },
        h('label', null, 'Dashboard title', (f.title = h('input', { value: s.title }))),
        h('label', null, 'Technical partner name', (f.techName = h('input', { value: s.techName }))),
        h('label', null, 'Project-management partner name', (f.pmName = h('input', { value: s.pmName }))),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => pop.replaceChildren() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save')),
      ),
    );
    f.title.focus();
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.replaceChildren(h('div', { class: 'toast', role: 'status' }, msg));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.replaceChildren(), 2500);
  }

  // ---------- boot ----------
  initTheme();
  for (const b of document.querySelectorAll('#view-switch button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#refresh').addEventListener('click', () => load({ refresh: true }));
  $('#theme').addEventListener('click', cycleTheme);
  $('#settings-btn').addEventListener('click', toggleSettings);
  initView();
  load();
  setInterval(() => {
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
    if (!state.editing && !typing && document.visibilityState === 'visible') load();
  }, POLL_MS);
})();
