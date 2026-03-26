#!/usr/bin/env node
/**
 * ai-telemetry server
 *
 * MCP mode (default)  → ensures daemon is running, registers heartbeat, runs MCP stdio
 * Daemon mode (--daemon) → runs HTTP :8765 (SQLite), monitors session heartbeats, self-terminates when idle
 *
 * Data stored in: $CLAUDE_PLUGIN_DATA/events.db  (or ~/.ai-telemetry/events.db)
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

// ── Config ───────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.AI_TELEMETRY_PORT || "8765", 10);
const DATA_DIR     = path.join(os.homedir(), ".ai-telemetry");
const DB_PATH      = path.join(DATA_DIR, "events.db");
const STATIC_DIR   = path.join(__dirname, "..", "static");
const PID_FILE     = path.join(DATA_DIR, "server.pid");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const SESSION_FILE = path.join(SESSIONS_DIR, `${process.pid}.json`);
const IS_DAEMON    = process.argv.includes("--daemon");

// ── HTTP helper (used by MCP tools in all modes) ─────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ── HTTP server (daemon mode only) ───────────────────────────────────────────

function startHttpServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT    NOT NULL DEFAULT 'skill',
      name       TEXT    NOT NULL,
      detail     TEXT,
      session_id TEXT,
      cwd        TEXT,
      timestamp  TEXT
    )
  `);

  // Migrate from old Python server's skill_events table if present
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  if (tables.includes("skill_events")) {
    db.exec(`
      INSERT OR IGNORE INTO events (id, event_type, name, detail, session_id, cwd, timestamp)
      SELECT id, 'skill', skill, args, session_id, cwd, timestamp FROM skill_events
    `);
    db.exec("DROP TABLE skill_events");
  }

  const insert = db.prepare(
    "INSERT INTO events (event_type, name, detail, session_id, cwd, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const OFFSETS = { "24h": "-1 day", "7d": "-7 days", "30d": "-30 days" };

  function getStats(period = "7d") {
    const offset = OFFSETS[period];
    const where = offset ? "WHERE timestamp >= datetime('now', ?)" : "";
    const p = offset ? [offset] : [];
    const run = (sql) => db.prepare(sql).all(...p);

    const sw = where ? `${where} AND event_type='skill'` : "WHERE event_type='skill'";
    const skillsRows = run(`SELECT name AS skill, COUNT(*) AS n FROM events ${sw} GROUP BY name ORDER BY n DESC LIMIT 15`);

    const aw = where ? `${where} AND event_type='agent'` : "WHERE event_type='agent'";
    const agentsRows = run(`SELECT name, COUNT(*) AS n FROM events ${aw} GROUP BY name ORDER BY n DESC LIMIT 15`);

    const mw = where ? `${where} AND event_type='mcp'` : "WHERE event_type='mcp'";
    const mcpRows = run(`SELECT name, COUNT(*) AS n FROM events ${mw} GROUP BY name ORDER BY n DESC LIMIT 15`);

    const timelineRaw = run(`SELECT date(timestamp) AS date, event_type, COUNT(*) AS n FROM events ${where} GROUP BY date(timestamp), event_type ORDER BY date`);
    const recentRows  = run(`SELECT id, event_type, name, cwd, timestamp FROM events ${where} ORDER BY id DESC LIMIT 30`);

    const tl = {};
    for (const r of timelineRaw) {
      if (!tl[r.date]) tl[r.date] = { skills: 0, agents: 0, mcp: 0 };
      const key = { skill: "skills", agent: "agents", mcp: "mcp" }[r.event_type];
      if (key) tl[r.date][key] = r.n;
    }
    const timeline = Object.entries(tl).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));

    const pct = (n, max) => (max ? Math.round((n / max) * 1000) / 10 : 0);
    const ms = skillsRows[0]?.n || 1, ma = agentsRows[0]?.n || 1, mm = mcpRows[0]?.n || 1;

    return {
      period,
      skills:  skillsRows.map((r) => ({ skill: r.skill, count: r.n, pct: pct(r.n, ms) })),
      agents:  agentsRows.map((r) => ({ name: r.name, count: r.n, pct: pct(r.n, ma) })),
      mcp:     mcpRows.map((r)    => ({ name: r.name, count: r.n, pct: pct(r.n, mm) })),
      timeline,
      recent: recentRows.map((r) => ({
        id: r.id, event_type: r.event_type, name: r.name,
        project: path.basename(r.cwd || "") || "—", timestamp: r.timestamp,
      })),
    };
  }

  const dashboardHtml = fs.existsSync(path.join(STATIC_DIR, "dashboard.html"))
    ? fs.readFileSync(path.join(STATIC_DIR, "dashboard.html"))
    : Buffer.from("<h1>Dashboard not found</h1>");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "POST" && url.pathname === "/api/events") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const d = JSON.parse(body);
          insert.run(d.event_type ?? "skill", d.name ?? d.skill ?? "unknown",
            d.detail ?? d.args ?? null, d.session_id ?? null,
            d.cwd ?? null, d.timestamp ?? new Date().toISOString());
        } catch (_) {}
        res.writeHead(204).end();
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const period = url.searchParams.get("period") || "7d";
      const stats = getStats(["24h", "7d", "30d", "all"].includes(period) ? period : "7d");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(stats));
      return;
    }

    if (req.method === "GET" && ["/", "/dashboard", "/api/dashboard", "/static/dashboard.html"].includes(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html" }).end(dashboardHtml);
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(`[ai-telemetry] Port ${PORT} in use — another daemon is already running.\n`);
      } else {
        process.stderr.write(`[ai-telemetry] HTTP error: ${err.message}\n`);
      }
      resolve(false);
    });
    server.listen(PORT, "127.0.0.1", () => {
      process.stderr.write(`[ai-telemetry] HTTP server listening on http://127.0.0.1:${PORT}\n`);
      resolve(true);
    });
  });
}

// ── Daemon mode ───────────────────────────────────────────────────────────────

async function startDaemon() {
  // Bind the port FIRST — only the winner writes the PID file.
  // This avoids the race where two daemons spawn simultaneously: the loser
  // would otherwise overwrite then delete the PID file that the winner owns.
  const bound = await startHttpServer();
  if (!bound) {
    // Lost the port race — another daemon is already running. Exit silently.
    process.exit(0);
    return;
  }

  // We won — now write the PID file so MCP sessions can find us.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  const cleanupPid = () => { try { fs.unlinkSync(PID_FILE); } catch (_) {} };
  process.on("exit", cleanupPid);
  process.on("SIGTERM", () => { cleanupPid(); process.exit(0); });
  process.on("SIGINT",  () => { cleanupPid(); process.exit(0); });

  // Grace period: wait before the first shutdown check so the first session
  // has time to write its heartbeat file after we start
  await new Promise((r) => setTimeout(r, 60_000));

  const monitor = setInterval(() => {
    const now = Date.now();
    let hasAliveSessions = false;

    try {
      const files = fs.readdirSync(SESSIONS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8");
          const { timestamp } = JSON.parse(raw);
          if (now - new Date(timestamp).getTime() < 90_000) {
            hasAliveSessions = true;
            break;
          }
        } catch (_) { /* malformed or deleted mid-read — skip */ }
      }
    } catch (_) { /* sessions dir doesn't exist yet — treat as no sessions */ }

    if (!hasAliveSessions) {
      process.stderr.write("[ai-telemetry] No alive sessions — daemon shutting down.\n");
      clearInterval(monitor);
      process.exit(0);
    }
  }, 30_000);
  monitor.unref(); // don't block the event loop if something else causes an exit
}

// ── Session heartbeat (MCP mode) ─────────────────────────────────────────────

function registerSession() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
}

function refreshHeartbeat() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
  } catch (_) { /* non-fatal */ }
}

function unregisterSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

function setupSessionCleanup() {
  const cleanup = () => { unregisterSession(); process.exit(0); };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT",  cleanup);
  process.on("exit",    () => unregisterSession()); // synchronous — no process.exit() here
}

// ── Ensure daemon is running (MCP mode) ──────────────────────────────────────

async function ensureDaemonRunning() {
  // Check for existing daemon via PID file
  let existingPid = null;
  try {
    existingPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch (_) { /* no PID file */ }

  if (existingPid) {
    try {
      process.kill(existingPid, 0); // throws ESRCH if process is gone
      return; // daemon is alive
    } catch (_) {
      // Stale PID file — daemon crashed or was killed
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
  }

  // Spawn a detached daemon
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(process.execPath, [__filename, "--daemon"], {
    detached: true,
    stdio:    "ignore",
    env:      process.env,
  });
  child.unref(); // don't hold a reference in this process's event loop

  // Poll for PID file (daemon writes it on startup) — up to 3s
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(PID_FILE)) break;
  }
}

// ── Main (MCP mode) ───────────────────────────────────────────────────────────

async function main() {
  await ensureDaemonRunning();

  registerSession();
  setupSessionCleanup();
  const hb = setInterval(refreshHeartbeat, 30_000);
  hb.unref();

  // ── MCP server (all modes — always fetches from HTTP daemon) ──────────────

  const mcpServer = new Server(
    { name: "ai-telemetry", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_stats",
        description: "Get Claude Code usage stats (skills, agents, MCP calls) for a time period.",
        inputSchema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              enum: ["24h", "7d", "30d", "all"],
              description: "Time period to query (default: 7d)",
            },
          },
        },
      },
      {
        name: "get_dashboard_url",
        description: "Get the URL to open the ai-telemetry dashboard in a browser.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "get_stats") {
      const period = request.params.arguments?.period || "7d";
      const stats = await httpGet(`http://127.0.0.1:${PORT}/api/stats?period=${period}`);
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
    if (request.params.name === "get_dashboard_url") {
      return { content: [{ type: "text", text: `http://127.0.0.1:${PORT}` }] };
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  // Cleanup happens via process.on('exit') and signal handlers registered in setupSessionCleanup()
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (IS_DAEMON) {
  startDaemon().catch((err) => {
    process.stderr.write(`[ai-telemetry] Daemon fatal: ${err.message}\n`);
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`[ai-telemetry] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
