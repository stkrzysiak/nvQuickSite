# project-dashboard

One page for everything under `~/dev/personal`. It scans that folder, reads each
project's git history and [Backlog.md](https://backlog.md) tasks, and shows the
result two ways:

- **`/tech`** – the technical view: branch, dirty files, ahead/behind upstream,
  last commit, commits per week, open tasks, detected stack, make targets,
  recent commits, and the full backlog per project.
- **`/pm`** – the project-management view: a plain-language summary, lifecycle
  status (active / blocked / paused / idea / shipped / archived), health,
  progress from the backlog, what's next, blockers, target dates, and a
  questions thread between the two of you.

Both views read the same data. Everything the PM view adds (summaries, statuses,
blockers, questions) is stored in `data/dashboard.json`; the project folders
themselves are never written to. No accounts, no auth: it is meant to sit on
tower's LAN address and nothing else.

## How it works

```
~/dev/personal/            (mounted read-only into the container)
├── maplegator/            git + backlog/  -> health, progress, next up, commits
├── plantgator/            git             -> health from commit recency
└── notes/                 plain folder    -> listed, "no data"
```

Per project the scanner reads:

| Source | Used for |
|---|---|
| `git` (branch, log, status, upstream, stash) | activity, health, sync state, weekly commit sparkline, TODO count |
| `backlog/config.yml` + `backlog/tasks/*.md` (+ `backlog/completed/`) | task counts, progress, "what's next", acceptance-criteria progress |
| `README.md`, `package.json`, `Makefile`, `.github/workflows`, marker files | title, description, stack tags, make targets, npm scripts |

Health is derived, never typed in: **Healthy** (activity in the last 7 days),
**Slowing** (8–30 days), **Stalled** (older), **Blocked** (a blocker is listed or
the status is blocked), **Dormant** (paused / idea / shipped / archived). Each
level has its own icon and label, so nothing depends on colour alone.

## Run it on tower

Requirements: Docker (already on tower) and this folder at
`~/dev/personal/project-dashboard` (it will show up in its own dashboard; add it
to `EXCLUDE` if you'd rather not).

```bash
cd ~/dev/personal/project-dashboard
cp .envrc.example .envrc && direnv allow     # optional; defaults are fine
make docker-up                               # builds the image, starts detached
make docker-logs                             # first scan takes a few seconds
```

Then open, from any device on the LAN:

- `http://<tower-ip>:8420/pm` – the project-management view (bookmark this for your partner)
- `http://<tower-ip>:8420/tech` – the technical view

The view toggle in the header switches between them and remembers the choice
per browser. The page re-polls every minute and the server rescans every
`SCAN_INTERVAL` seconds (default 300); **Refresh** forces a rescan.

### Open the port on tower's firewall

tower runs NixOS with an iptables-based `nixos-fw` chain that already scopes
other services to the LAN. Add the dashboard the same way in
`nix/hosts/tower/configuration.nix`:

```nix
networking.firewall.extraCommands = ''
  iptables -A nixos-fw -p tcp -s 192.168.1.0/24 --dport 8420 -j nixos-fw-accept
'';
```

then `make rebuild` in `~/configs/nix`. Keep it to the LAN subnet; the dashboard
has no authentication.

### Start on boot (optional)

`restart: unless-stopped` in the compose file already brings the container back
after a reboot once Docker starts. If you would rather manage it like the
maplegator units, a matching systemd unit is:

```nix
systemd.services.project-dashboard = {
  description = "Project dashboard (tech + PM views)";
  wantedBy = [ "multi-user.target" ];
  after = [ "docker.service" "network-online.target" ];
  requires = [ "docker.service" ];
  path = with pkgs; [ gnumake bash coreutils docker_29 ];
  serviceConfig = {
    Type = "oneshot";
    RemainAfterExit = true;
    User = "stk";
    Group = "users";
    SupplementaryGroups = [ "docker" ];
    WorkingDirectory = "/home/stk/dev/personal/project-dashboard";
    ExecStart = "${pkgs.gnumake}/bin/make docker-up";
    ExecStop = "${pkgs.gnumake}/bin/make docker-down";
  };
};
```

## Run it locally

Needs Node 20+ and git on `PATH` (`nix-shell` picks both up from `shell.nix`).

```bash
make run                                  # http://localhost:8420, scans ~/dev/personal
PROJECTS_ROOT=~/dev/clients make run      # scan somewhere else
make dev                                  # restart on file changes
make test                                 # unit + API tests (builds temp git repos)
```

## Configuration

All optional. Set them in `.envrc` (see `.envrc.example`) or the environment.

| Variable | Default | Meaning |
|---|---|---|
| `PROJECTS_ROOT` | `~/dev/personal` (local) / `/projects` (container) | folder to scan, one project per subfolder |
| `DATA_DIR` | `./data` (local) / `/data` (container) | where `dashboard.json` lives |
| `PORT`, `HOST` | `8420`, `0.0.0.0` | listen address |
| `SCAN_INTERVAL` | `300` | seconds between automatic rescans; `0` disables |
| `EXCLUDE` | empty | comma-separated folder names to skip |
| `DASHBOARD_PORT` | `8420` | (compose) host port |
| `DASHBOARD_UID` / `DASHBOARD_GID` | `1000` / `100` | (compose) run the container as this user so the read-only mount and `./data` are readable/writable |

Names shown in the questions thread ("Tech" / "PM") and the dashboard title are
set from the gear icon in the header.

## API

Everything the UI does goes through this JSON API, so it is scriptable.

| Method | Path | |
|---|---|---|
| `GET` | `/api/projects` | every project with git, backlog, stack, meta and derived fields, plus the summary counts |
| `GET` | `/api/projects/:id` | one project |
| `POST` | `/api/refresh` | rescan now |
| `PUT` | `/api/projects/:id/meta` | update summary, status, priority, owner, targetDate, nextMilestone, blockers, links, notes, hidden |
| `POST` | `/api/projects/:id/questions` | `{ from: "pm" \| "tech", text }` |
| `PATCH` | `/api/projects/:id/questions/:qid` | `{ answer?, resolved?, text? }` |
| `DELETE` | `/api/projects/:id/questions/:qid` | |
| `GET` / `PUT` | `/api/settings` | `{ title, techName, pmName }` |
| `GET` | `/api/health` | liveness |

## Layout

```
server/   index.js (http + routes)  scanner.js  git.js  backlog.js  stack.js  derive.js  store.js  frontmatter.js
public/   index.html  app.js  styles.css        (no build step)
test/     node --test suites; api.test.js boots the server against temp git repos
backlog/  this project's own Backlog.md tasks
data/     dashboard.json (gitignored)
```

No npm dependencies. The container image is `node:22-alpine` plus `git`.
