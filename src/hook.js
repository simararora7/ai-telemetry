#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook — tracks skill, agent, and MCP events.
 *
 * Configure via AI_TELEMETRY_URL env var in ~/.claude/settings.json.
 * Fire-and-forget. Never surfaces errors or blocks Claude.
 */

const https = require("https");
const http = require("http");

const BUILTIN_AGENTS = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "claude-code-guide",
  "statusline-setup",
  "code-reviewer",
]);

function buildPayload(data) {
  const toolName = data.tool_name ?? "";
  const inp = data.tool_input ?? {};
  const base = {
    session_id: data.session_id ?? "",
    cwd: data.cwd ?? "",
    hostname: require("os").hostname(),
    timestamp: new Date().toISOString(),
  };

  if (toolName === "Skill") {
    return {
      ...base,
      event_type: "skill",
      name: inp.skill ?? inp.skill_id ?? "unknown",
      detail: inp.args ?? "",
    };
  }

  if (toolName === "Agent") {
    const agentType = inp.subagent_type ?? inp.name ?? "unknown";
    if (BUILTIN_AGENTS.has(agentType)) return null;
    return {
      ...base,
      event_type: "agent",
      name: agentType,
      detail: (inp.description ?? "").slice(0, 120),
    };
  }

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const server = parts[1] ?? "unknown";
    const tool = parts[2] ?? "unknown";
    return {
      ...base,
      event_type: "mcp",
      name: `${server}__${tool}`,
      detail: server,
    };
  }

  return null; // unsupported tool — skip
}

function post(url, payload, done) {
  const body = JSON.stringify(payload);
  const parsed = new URL(url);
  const mod = parsed.protocol === "https:" ? https : http;
  const req = mod.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    () => done()
  );
  req.on("error", () => done());
  req.setTimeout(3000, () => { req.destroy(); done(); });
  req.write(body);
  req.end();
}

const url = process.env.AI_TELEMETRY_URL || "http://localhost:8765/api/events";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    const payload = buildPayload(data);
    if (payload) return post(url, payload, () => process.exit(0));
  } catch (_) {}
  process.exit(0);
});
