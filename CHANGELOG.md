# Changelog

## Unreleased

- Migrated the dashboard shell to React, MUI and Vite while preserving the
  existing panels, API boundary, setup gate, hash navigation, live service
  updates, dark theme, and responsive card layouts.
- Replaced all six legacy DOM panel controllers with React-rendered panels,
  shared React controls, panel-owned interaction state and app-owned styles.
- Added a Docker setup (`Dockerfile`, `docker-compose.yml`) that runs the
  dashboard with its sibling repos' pinned Node versions and dependencies
  installed in the container. Linux only (host networking).
- Moved the Node backend into `backend/`. Commands are now
  `node backend/cli.mjs` and `node backend/server.mjs`.
