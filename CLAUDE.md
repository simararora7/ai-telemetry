# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin that tracks skill, agent, and MCP tool usage across sessions. It uses a PostToolUse hook to capture events, stores them in SQLite, and serves a live dashboard.

## Key commands

```bash
# Install dependencies
npm install

# Run the server directly (starts HTTP server + MCP stdio)
node src/server.js

# Run via the start script (auto-installs deps if missing)
src/start.sh
```

There are no tests or lint scripts defined in `package.json`.

## Architecture

The plugin has three components that interact:

### `src/hook.js` — PostToolUse hook (fire-and-forget)
Reads a JSON event from stdin (injected by Claude Code after each tool call), classifies it as a `skill`, `agent`, or `mcp` event, and POSTs it to the HTTP server at `AI_TELEMETRY_URL` (default `http://localhost:8765/api/events`). Built-in agents (`general-purpose`, `Explore`, `Plan`, etc.) are filtered out. Never blocks or surfaces errors to Claude.

### `src/server.js` — Dual-mode: MCP session + HTTP daemon

The file runs in two modes determined by the `--daemon` argv flag:

- **MCP mode** (default, one per Claude Code session): calls `ensureDaemonRunning()` to spawn the HTTP daemon if not already running, writes a heartbeat file to `~/.ai-telemetry/sessions/<pid>.json`, then runs the MCP stdio server. The heartbeat is refreshed every 30s. On exit the session file is deleted.
- **Daemon mode** (`--daemon`, one shared background process): binds port 8765, owns the SQLite database, serves the dashboard and REST API. After a 60s startup grace period it monitors `~/.ai-telemetry/sessions/` every 30s and self-terminates when no session file has been updated in the last 90s.

The daemon is spawned with `detached: true` so it outlives any single Claude Code session. The HTTP server persists as long as **any** session is alive; it shuts down only when all sessions have exited.

**HTTP API endpoints:**
- `POST /api/events` — ingests an event from the hook
- `GET /api/stats?period=24h|7d|30d|all` — returns aggregated stats JSON
- `GET /` — serves the dashboard HTML

**SQLite schema** (single `events` table):
```
id, event_type (skill|agent|mcp), name, detail, session_id, cwd, hostname, timestamp
```
On first startup, any legacy `skill_events` table (from a prior Python server) is migrated and dropped.

**Runtime files** (all under `~/.ai-telemetry/`):
```
events.db       — SQLite database (persists across restarts)
server.pid      — PID of the running HTTP daemon
sessions/<pid>.json — heartbeat file per active MCP session
```

### `static/dashboard.html` — Self-contained dashboard
Single HTML file loaded into memory at server start. Uses Chart.js (CDN) for the timeline chart. All data is fetched from `/api/stats` on the same origin.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AI_TELEMETRY_URL` | `http://localhost:8765/api/events` | Hook POST target (set in `~/.claude/settings.json`) |
| `AI_TELEMETRY_PORT` | `8765` | HTTP server port |
| `CLAUDE_PLUGIN_DATA` | `~/.ai-telemetry` | Data directory override |