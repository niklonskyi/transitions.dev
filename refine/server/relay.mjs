// Refine relay — local server behind the timeline panel's Refine button.
//
// It does two jobs:
//   1. Serves the injectable timeline at GET /inject.js, so any page can show
//      the panel with a single <script> tag (no npm install — see bin/cli.mjs).
//   2. Brokers refine jobs between the browser and whoever answers them.
//
//   Browser ──POST /jobs──►  relay  ──►  answer  ──►  Browser ──GET /jobs/:id──►
//
// Who answers a job (chosen per request via the panel's LLM / Deterministic tabs):
//   • Deterministic → answered in-process by snapping each value to the nearest
//     transitions.dev motion token (zero-config, not usage-aware).
//   • LLM → answered by a real agent. Two ways to provide one:
//       a) A polling agent in your editor: run `/refine live` in Cursor/Codex.
//          It long-polls GET /jobs/next, reasons with the transitions-dev skill,
//          and POSTs the result back. This is the default, install-free path.
//       b) A headless CLI: start the relay with REFINE_AGENT_CMD set and the
//          relay spawns it once per job (stdin = prompt, stdout = JSON).
//          e.g.  REFINE_AGENT_CMD='cursor-agent -p' npm run relay
//
// Run: node server/relay.mjs   (or: npm run relay)

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { refineTimings } from "./motion-tokens.mjs";
import { buildInjectModule } from "./inject.mjs";

const PORT = Number(process.env.REFINE_RELAY_PORT) || 7331;
const AUTO = process.env.REFINE_AUTO !== "0";
const AGENT_CMD = process.env.REFINE_AGENT_CMD || null;
const AGENT_TIMEOUT_MS = Number(process.env.REFINE_AGENT_TIMEOUT_MS) || 120000;
const LONGPOLL_MS = Number(process.env.REFINE_LONGPOLL_MS) || 25000;
// Grace window after a `/refine live` agent's last poll during which LLM mode is
// still reported "available". Kept well above LONGPOLL_MS so the normal gaps
// between an in-IDE agent's polls (reasoning, posting results, brief turn pauses)
// don't flip the panel's LLM tab off mid-session.
const POLLER_TTL_MS = Number(process.env.REFINE_POLLER_TTL_MS) || 120000;
// How long a pending LLM job waits to be claimed before erroring. Comfortably
// above one long-poll cycle so a transient polling gap doesn't fail the job.
const PENDING_TIMEOUT_MS = Number(process.env.REFINE_PENDING_TIMEOUT_MS) || 120000;

/** @type {Map<string, Job>} */
const jobs = new Map();
const now = () => Date.now();

// When did a `/refine live` agent last poll? Used to know if LLM mode can be
// served by a live editor agent (vs. needing REFINE_AGENT_CMD).
let lastPollAt = 0;
const pollerActive = () => now() - lastPollAt < POLLER_TTL_MS;
const llmAvailable = () => Boolean(AGENT_CMD) || pollerActive();

// Whether the Cursor CLI (cursor-agent) is installed on this machine. Drives the
// panel's two agent-unavailable states: "Cursor CLI not installed" vs. simply
// "run /refine live". A wired REFINE_AGENT_CMD implies it's present.
const HOME = homedir();
const AGENT_BIN_CANDIDATES = [
  join(HOME, ".local", "bin", "cursor-agent"),
  "/usr/local/bin/cursor-agent",
  "/opt/homebrew/bin/cursor-agent",
];
function cursorCliInstalled() {
  if (AGENT_CMD) return true;
  for (const p of AGENT_BIN_CANDIDATES) {
    try { if (existsSync(p)) return true; } catch {}
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try { if (existsSync(join(dir, "cursor-agent"))) return true; } catch {}
  }
  return false;
}

function createJob(request) {
  const id = randomUUID();
  const job = {
    id,
    status: "pending", // pending | working | done | error
    request,
    statusLog: [],
    result: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
  jobs.set(id, job);
  if (jobs.size > 100) {
    const oldest = [...jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest && oldest.status !== "pending" && oldest.status !== "working") jobs.delete(oldest.id);
  }
  return job;
}

// LLM jobs left pending for a `/refine live` agent to claim via GET /jobs/next.
function nextPendingLlm() {
  let oldest = null;
  for (const job of jobs.values()) {
    if (job.status !== "pending") continue;
    if ((job.request?.mode || "llm") !== "llm") continue;
    if (!oldest || job.createdAt < oldest.createdAt) oldest = job;
  }
  return oldest;
}

// ── answering a job (one run per job) ────────────────────────────────────────

function buildPrompt(job) {
  const r = job.request || {};
  const refineType = (r.refineType || "small") === "replace" ? "replace" : "small";
  const lines = [
    "You are refining ONE CSS transition against the transitions.dev library and motion tokens.",
    "Read the transitions-dev skill's SKILL.md (look in .agents/skills/transitions-dev/ or ~/.agents/skills/transitions-dev/) and apply its `transitions refine` behaviour, `## Motion tokens`, and `## Decision rules`.",
    "",
    "Transition context (JSON):",
    JSON.stringify({ label: r.label, selector: r.selector, refineType, timings: r.timings }, null, 2),
    "",
    "Infer each declaration's USAGE (modal close, dropdown open, tooltip, badge, resize, color/theme change…) from the label/selector. Match on usage intent, not the nearest number.",
    "",
  ];
  if (refineType === "replace") {
    lines.push(
      "refineType is \"replace\": suggest a WHOLE-TRANSITION replacement ONLY — do NOT propose motion-token tweaks (no kind \"duration\"/\"delay\"/\"easing\").",
      "Run the skill's `## Decision rules` on the inferred usage, pick the SINGLE best-fit transitions.dev recipe, and read its reference file (e.g. 06-modal.md) for the real timings/easing. Emit ONE suggestion with kind \"replace\": set its `patch` to the recipe's recommended duration/easing for the property that already transitions (or \"all\") so Apply works live, add a `reference` field with the reference filename, and name the recipe in `title`/`reason`. Never invent timings — quote the reference file. If no recipe genuinely fits the usage, return an empty suggestions array.",
    );
  } else {
    lines.push(
      "refineType is \"small\": FIRST suggest motion-token tweaks — for each declaration, propose the token value only where it DIFFERS from the current one (kind \"duration\"/\"delay\"/\"easing\").",
      "THEN, when it is possible and sensible, ALSO add at most ONE kind \"replace\" suggestion (alongside, not instead of, the token tweaks): run the skill's `## Decision rules`, pick the SINGLE best-fit recipe, read its reference file for the real timings, set its `patch` to the recipe's recommended duration/easing for the existing property (or \"all\"), add a `reference` field with the reference filename, and name the recipe in `title`/`reason`. Only add it when the transition is clearly a hand-rolled version of a catalogued recipe or is missing structure the usage calls for; otherwise omit it and let the token tweaks stand alone.",
    );
  }
  lines.push(
    "",
    "Output ONLY a JSON object — no prose, no markdown fences — shaped exactly like:",
    '{"summary":"…","suggestions":[{"id":"width-duration","kind":"duration","property":"width","title":"Duration → Fast","from":"400ms","to":"250ms","patch":{"property":"width","durationMs":250},"reason":"…"}]}',
    'In each `patch` include only the changed fields (durationMs, delayMs, easing); `property` must match an input property or "all". If nothing should change, return an empty suggestions array.',
  );
  return lines.join("\n");
}

function parseAgentOutput(stdout) {
  let s = (stdout || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) obj = JSON.parse(s.slice(a, b + 1));
    else throw new Error("agent output was not JSON");
  }
  if (!obj || !Array.isArray(obj.suggestions)) throw new Error("agent output missing suggestions[]");
  return { suggestions: obj.suggestions, summary: obj.summary ?? null };
}

function runAgentCmd(cmd, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`REFINE_AGENT_CMD timed out after ${AGENT_TIMEOUT_MS}ms`));
    }, AGENT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to start REFINE_AGENT_CMD: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`agent exited ${code}: ${err.slice(0, 300)}`));
      try {
        resolve(parseAgentOutput(out));
      } catch (e) {
        reject(new Error(`${e.message} — got: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function refineDeterministic(job) {
  // Whole-transition replacement needs usage inference + recipe selection, which
  // only the agent (LLM) path can do. Deterministic can only snap to tokens.
  if ((job.request?.refineType || "small") === "replace") {
    return {
      suggestions: [],
      summary: "Replacing a whole transition needs the agent — switch to the Agent tab and run `/refine live`.",
    };
  }
  const suggestions = refineTimings(job.request?.timings || []);
  return {
    suggestions,
    summary: suggestions.length
      ? `${suggestions.length} value${suggestions.length === 1 ? "" : "s"} differ from the transitions.dev tokens.`
      : "Already aligned to the motion tokens.",
  };
}

async function answerJob(job) {
  job.status = "working";
  job.updatedAt = now();
  const label = job.request?.label || job.request?.selector || "transition";
  // The browser picks the mode per job via the LLM / Deterministic tabs.
  // Default: LLM when a command is configured, otherwise deterministic.
  const mode = job.request?.mode || (AGENT_CMD ? "llm" : "deterministic");
  job.statusLog.push({ message: `Scanning "${label}"…`, at: now() });
  try {
    let result;
    if (mode === "llm") {
      if (!AGENT_CMD) {
        throw new Error(
          "LLM mode needs an agent CLI. Restart the relay with REFINE_AGENT_CMD set " +
            "(e.g. REFINE_AGENT_CMD='cursor-agent -p' npm run relay), or switch to the Deterministic tab."
        );
      }
      job.statusLog.push({ message: "Asking your agent…", at: now() });
      result = await runAgentCmd(AGENT_CMD, buildPrompt(job));
    } else {
      job.statusLog.push({ message: "Matching values to the motion tokens…", at: now() });
      result = refineDeterministic(job);
    }
    job.result = { suggestions: result.suggestions, summary: result.summary };
    job.status = "done";
    job.updatedAt = now();
    console.log(`  ✓ job ${job.id.slice(0, 8)} — ${result.suggestions.length} suggestion(s)`);
  } catch (e) {
    job.error = String(e.message || e);
    job.status = "error";
    job.updatedAt = now();
    console.error(`  ✗ job ${job.id.slice(0, 8)} — ${job.error}`);
  }
}

// ── http plumbing ────────────────────────────────────────────────────────────

function send(res, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") return send(res, 204);

  if (method === "GET" && path === "/health") {
    return send(res, 200, {
      ok: true,
      auto: AUTO,
      llmAvailable: llmAvailable(),
      pollerActive: pollerActive(),
      agentCmd: Boolean(AGENT_CMD),
      cliInstalled: cursorCliInstalled(),
      jobs: jobs.size,
    });
  }

  // GET /inject.js — the self-mounting timeline, served to any page.
  if (method === "GET" && (path === "/inject.js" || path === "/timeline.mjs")) {
    try {
      const mod = await buildInjectModule({ noCache: process.env.REFINE_INJECT_NOCACHE === "1" });
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      return res.end(mod);
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  // POST /jobs — browser enqueues a refine request.
  if (method === "POST" && path === "/jobs") {
    const body = await readJson(req);
    if (!body || typeof body.request !== "object" || body.request === null) {
      return send(res, 400, { error: "Body must be { request: {...} }" });
    }
    const job = createJob(body.request);
    const mode = job.request.mode || (llmAvailable() ? "llm" : "deterministic");
    job.request.mode = mode;

    if (!AUTO) {
      // External-poller-only mode: everything waits on GET /jobs/next.
    } else if (mode === "deterministic") {
      setImmediate(() => answerJob(job)); // in-process, off the response path
    } else if (AGENT_CMD) {
      setImmediate(() => answerJob(job)); // spawn the configured CLI once
    } else if (pollerActive()) {
      // A `/refine live` agent is polling — leave it pending for them to claim.
      job.statusLog.push({ message: "Waiting for your agent (/refine live)…", at: now() });
      setTimeout(() => {
        if (job.status === "pending" || job.status === "working") {
          job.status = "error";
          job.error = "No agent answered in time. Is `/refine live` still running?";
          job.updatedAt = now();
        }
      }, PENDING_TIMEOUT_MS);
    } else {
      job.status = "error";
      job.error =
        "LLM mode needs a live agent. In Cursor/Codex run `/refine live`, " +
        "or start the relay with REFINE_AGENT_CMD set — or use the Deterministic tab.";
    }
    return send(res, 201, { id: job.id, status: job.status });
  }

  // GET /jobs/next — long-poll claimed by a `/refine live` agent (LLM jobs).
  if (method === "GET" && path === "/jobs/next") {
    lastPollAt = now();
    const deadline = now() + LONGPOLL_MS;
    const attempt = () => {
      if (res.writableEnded) return;
      const job = nextPendingLlm();
      if (job) {
        job.status = "working";
        job.updatedAt = now();
        return send(res, 200, { id: job.id, request: job.request });
      }
      if (now() >= deadline) return send(res, 204);
      setTimeout(attempt, 400);
    };
    return attempt();
  }

  const m = path.match(/^\/jobs\/([^/]+)(?:\/(status|result|error))?$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: "No such job" });
    const sub = m[2];

    if (method === "GET" && !sub) {
      return send(res, 200, {
        id: job.id,
        status: job.status,
        statusLog: job.statusLog,
        result: job.result,
        error: job.error,
      });
    }

    if (method === "POST" && sub === "status") {
      const body = await readJson(req);
      const message = body && typeof body.message === "string" ? body.message : null;
      if (!message) return send(res, 400, { error: "Body must be { message }" });
      job.statusLog.push({ message, at: now() });
      job.updatedAt = now();
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && sub === "result") {
      const body = await readJson(req);
      const suggestions = body && Array.isArray(body.suggestions) ? body.suggestions : null;
      if (!suggestions) return send(res, 400, { error: "Body must be { suggestions: [...] }" });
      job.result = { suggestions, summary: body.summary ?? null };
      job.status = "done";
      job.updatedAt = now();
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && sub === "error") {
      const body = await readJson(req);
      job.error = (body && body.message) || "Agent reported an error";
      job.status = "error";
      job.updatedAt = now();
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`refine relay listening on http://localhost:${PORT}`);
  console.log(`  timeline injectable at  http://localhost:${PORT}/inject.js`);
  if (!AUTO) {
    console.log("  auto-answer OFF (REFINE_AUTO=0) — all jobs wait for a poller on GET /jobs/next");
  } else if (AGENT_CMD) {
    console.log(`  LLM jobs answered by spawning: ${AGENT_CMD}`);
  } else {
    console.log("  LLM jobs wait for a live agent — run `/refine live` in Cursor/Codex.");
    console.log(`  live agent stays 'available' for ${Math.round(POLLER_TTL_MS / 1000)}s after its last poll.`);
    console.log("  Deterministic jobs answered in-process (nearest motion token).");
  }
});
