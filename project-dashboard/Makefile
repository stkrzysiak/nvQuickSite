.PHONY: help run dev test docker-build docker-up docker-down docker-logs docker-restart

# Extra arguments for any target: make run FLAGS="..."
FLAGS ?=

# Where the projects live. Locally the server defaults to ~/dev/personal; the
# compose file mounts this same path into the container at /projects.
PROJECTS_ROOT ?= $(HOME)/dev/personal
export PROJECTS_ROOT

help:
	@echo "project-dashboard"
	@echo ""
	@echo "  Local (needs node >= 20 and git on PATH):"
	@echo "    make run            start the server on http://localhost:8420"
	@echo "    make dev            same, restarts on file changes"
	@echo "    make test           run the unit + API tests"
	@echo ""
	@echo "  Docker (how it runs on tower):"
	@echo "    make docker-build   build the image"
	@echo "    make docker-up      build and start in the background"
	@echo "    make docker-down    stop and remove the container"
	@echo "    make docker-restart rebuild and restart after a code change"
	@echo "    make docker-logs    follow the container log"
	@echo ""
	@echo "  Variables: PROJECTS_ROOT (default ~/dev/personal), PORT, SCAN_INTERVAL, EXCLUDE, FLAGS"

# Serve directly with node; PORT/SCAN_INTERVAL/EXCLUDE pass through from the env.
run:
	node server/index.js $(FLAGS)

dev:
	node --watch server/index.js $(FLAGS)

test:
	node --test test/*.test.js $(FLAGS)

docker-build:
	docker compose build $(FLAGS)

# Detached; the compose file reads PROJECTS_ROOT and DASHBOARD_* from the env
# (or a .envrc via direnv). Data persists in ./data across restarts.
docker-up:
	docker compose up -d --build $(FLAGS)

docker-down:
	docker compose down $(FLAGS)

docker-restart: docker-up

docker-logs:
	docker compose logs -f --tail=100 $(FLAGS)
