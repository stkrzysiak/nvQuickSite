---
id: TASK-1
title: Build the project dashboard with tech and PM views
status: In Progress
assignee: []
created_date: '2026-09-27 20:00'
labels:
  - human
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A dashboard over every project under ~/dev/personal, hosted on tower and reached over the LAN by IP. Two views of the same data: a technical view (git state, commits, backlog tasks, stack) and a project-management view for a non-engineering partner (plain-language summary, lifecycle status, progress, what's next, blockers, questions). Zero-dependency Node server + vanilla frontend, packaged with Docker Compose.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Scans PROJECTS_ROOT and reads git, Backlog.md and stack markers per project
- [x] #2 /tech and /pm views over the same data, with a project drawer for each
- [x] #3 PM metadata (status, summary, blockers, target date, questions) editable in the UI and persisted in data/dashboard.json
- [x] #4 Unit + API tests pass with `make test`
- [ ] #5 Deployed on tower via `make docker-up` and reachable from the partner's device at http://<tower-ip>:8420/pm
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Deployment on tower (AC #5) needs a human: clone/move this folder to ~/dev/personal/project-dashboard, copy .envrc.example to .envrc, run `make docker-up`, and open the port to the LAN in the tower firewall (see README). Mark done once the partner can load the PM view.
<!-- SECTION:NOTES:END -->
