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
//          e.g.  REFINE_AGENT_CMD='cursor-agent -p --trust --force' npm run relay
//          (for cursor-agent the relay auto-appends any missing -p/--trust/--force
//          so headless jobs don't fail the workspace-trust prompt.)
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

// A bare `cursor-agent` goes interactive: it prints "⚠ Workspace Trust Required"
// and exits 1, so every headless refine/scan/apply job fails. Force the headless
// trio whenever the command is cursor-agent: -p (print/headless, reads the prompt
// from stdin), --trust (trust the workspace without prompting; only valid with
// --print), and --force (auto-allow tool calls so apply/scan don't hang on
// approval). Append only the missing flags; leave non-cursor-agent commands alone.
function augmentAgentCmd(cmd) {
  if (!cmd || !/(^|\s|\/)cursor-agent(\s|$)/.test(cmd)) return cmd;
  const has = (...flags) => flags.some((f) => new RegExp(`(^|\\s)${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(cmd));
  const extra = [];
  if (!has("-p", "--print")) extra.push("-p");
  if (!has("--trust")) extra.push("--trust");
  if (!has("-f", "--force", "--yolo")) extra.push("--force");
  return extra.length ? `${cmd} ${extra.join(" ")}` : cmd;
}
const AGENT_CMD = augmentAgentCmd(process.env.REFINE_AGENT_CMD || null);
// Pin a fast model for scan jobs. Grouping is a structured task that doesn't
// need a heavy reasoning model, and the user's *default* model may be a slow one
// (Opus / GPT-5.5) — forcing a fast model here keeps the initial scan snappy.
// Override with REFINE_SCAN_MODEL=""  to fall back to the agent's default.
const SCAN_MODEL = process.env.REFINE_SCAN_MODEL ?? "composer-2.5-fast";
const AGENT_TIMEOUT_MS = Number(process.env.REFINE_AGENT_TIMEOUT_MS) || 120000;

// Inject `--model <m>` into a `cursor-agent …` command (after the binary).
// IMPORTANT: `--model` and the SCAN_MODEL slug (e.g. "composer-2.5-fast") are
// cursor-agent-specific. If a user wired a different CLI (Codex, Claude Code, …)
// into REFINE_AGENT_CMD, appending the flag would be invalid and break the scan,
// so we leave non-cursor commands untouched — those agents still get the speedup
// from the trimmed scan prompt. Also a no-op when the model is empty
// (REFINE_SCAN_MODEL="") or a model is already pinned explicitly.
function withModel(cmd, model) {
  if (!cmd || !model) return cmd;
  if (!/cursor-agent/.test(cmd)) return cmd; // not cursor-agent → don't touch
  if (/(^|\s)--model(\s|=)/.test(cmd)) return cmd; // respect an explicit choice
  return cmd.replace(/^(\s*\S+)/, `$1 --model ${model}`);
}
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
  const rawType = r.refineType || "small";
  const refineType = rawType === "replace" ? "replace" : rawType === "both" ? "both" : "small";
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
  } else if (refineType === "both") {
    lines.push(
      "refineType is \"both\": produce TWO independent groups in the SAME suggestions array — the UI shows them in separate tabs, so include each group whenever it applies.",
      "(1) Motion-token tweaks (kind \"duration\"/\"delay\"/\"easing\"): for each declaration, propose the token value only where it DIFFERS from the current one.",
      "(2) Whole-transition replacement (kind \"replace\"): ALWAYS evaluate one — run the skill's `## Decision rules` on the inferred usage, pick the SINGLE best-fit transitions.dev recipe, and read its reference file (e.g. 06-modal.md) for the real timings/easing. Emit at most ONE \"replace\" suggestion: set its `patch` to the recipe's recommended duration/easing for the property that already transitions (or \"all\"), add a `reference` field with the reference filename, and name the recipe in `title`/`reason`. Never invent timings — quote the reference file. If no recipe genuinely fits the usage, simply omit the replace suggestion.",
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

function parseJsonish(stdout) {
  let s = (stdout || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("agent output was not JSON");
  }
}

function parseAgentOutput(stdout) {
  const obj = parseJsonish(stdout);
  if (!obj || !Array.isArray(obj.suggestions)) throw new Error("agent output missing suggestions[]");
  return { suggestions: obj.suggestions, summary: obj.summary ?? null };
}

// Apply jobs ask the agent to edit the user's source, so the result is an
// outcome, not suggestions.
function parseApplyOutput(stdout) {
  const obj = parseJsonish(stdout);
  if (!obj || typeof obj.applied === "undefined") throw new Error("agent output missing `applied`");
  return { applied: Boolean(obj.applied), summary: obj.summary ?? null, files: Array.isArray(obj.files) ? obj.files : null };
}

// Scan jobs ask the agent to read the source and group related transitions into
// components with open/close phases and member elements.
function parseScanOutput(stdout) {
  const obj = parseJsonish(stdout);
  if (!obj || !Array.isArray(obj.groups)) throw new Error("agent output missing groups[]");
  return { groups: obj.groups, summary: obj.summary ?? null };
}

function runAgentCmd(cmd, prompt, parse = parseAgentOutput) {
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
        resolve(parse(out));
      } catch (e) {
        reject(new Error(`${e.message} — got: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Prompt for an "apply" job: the agent edits the user's source so the selected
// transition uses the approved timings.
function buildApplyPrompt(job) {
  const r = job.request || {};
  return [
    "You are APPLYING an approved transition change to the user's SOURCE CODE. Edit files; do not just suggest.",
    "",
    "Change context (JSON):",
    JSON.stringify({ label: r.label, selector: r.selector, component: r.component, group: r.group, phase: r.phase, changes: r.changes }, null, 2),
    "",
    "If `phase` is set (e.g. \"open\"/\"close\"), the change targets ONE state of a component — edit the rule for THAT state (e.g. the `.is-open` rule for open, the `.is-closing`/base rule for close), not the other phase. Each change may carry its own `member` + `selector` identifying which element it belongs to.",
    "",
    "Steps:",
    "1. Find where this transition is defined in the source. Search by the per-change `selector`/`member`, the `component` hint, and class names. Handle plain CSS, CSS Modules, styled-components/emotion template literals, Tailwind utilities/config, inline style objects, and Motion/Framer variants — the browser selector is a hint, the real declaration may live in any of these.",
    "2. For each change, edit the source so that property's transition uses the `to` values: durationMs (ms), easing, delayMs (ms). Keep the file's existing unit/format conventions (e.g. `0.25s` vs `250ms`) and only touch the timing of the named property on the right member + phase. If a CSS variable / design token backs the value, update it at the most sensible single place.",
    "3. Make the minimal edit. Do not reformat or change unrelated code.",
    "",
    'Output ONLY a JSON object — no prose, no markdown fences — shaped exactly like:',
    '{"applied":true,"summary":"Set .modal transition to 250ms ease-out","files":["src/Modal.css:42"]}',
    'If you cannot confidently locate the declaration, output {"applied":false,"summary":"<what you looked for and why it was not found>"}.',
  ].join("\n");
}

// Prompt for a "scan" job: the agent reads the source and groups the raw,
// DOM-detected transitions into components with open/close phases and members.
function buildScanPrompt(job) {
  const r = job.request || {};
  return [
    "You are GROUPING UI transitions by reading the user's SOURCE CODE. A naive DOM scan only sees each element's current computed transition — it cannot tell open from close, and lists related elements separately. Fix that.",
    "",
    "Raw DOM-detected transitions (JSON). Each entry's `timings` are ALREADY ACCURATE for the component's CURRENT on-screen state — treat them as ground truth, do NOT re-derive them from source. Most entries also carry `cssRules`: the CSS rules harvested live from the page (CSSOM) that drive that element across ALL states (base + open + close), with var() already resolved to concrete values.",
    JSON.stringify({ url: r.url, raw: r.raw }, null, 2),
    "",
    "FAST PATH — when an entry has `cssRules`, they are AUTHORITATIVE and contain everything you need: the opposite-phase timings live on a state-variant selector inside them (e.g. `.dd.is-closing .dd-panel`, `.modal[data-closing] .dialog`), and the toggled state is visible in those selectors. Derive grouping, phases, toggled state, and opposite-phase timings DIRECTLY from `cssRules` + `timings`. Do NOT glob, grep, or read files for any element whose `cssRules` is non-empty — it only wastes time. ONLY fall back to reading source for entries with an empty/missing `cssRules` (CORS-locked sheets, styled-components, Tailwind, etc.), and even then read the minimum.",
    "",
    "Steps:",
    "1. Identify each animated UI component (dropdown, modal, tooltip, accordion, drawer, toast…). The provided `label`/`selector`/`properties` usually make the grouping obvious; only read source when the grouping is genuinely unclear.",
    "2. For each component, split into PHASES — typically `open` and `close` (a hover-only component may have a single phase). The phase matching the CURRENT DOM state reuses the provided timings verbatim. The OPPOSITE phase often lives on a different selector (e.g. `.is-open` vs `.is-closing`) with different timings — take it from this element's `cssRules` (or, only if it has none, read source). Report BOTH even though only one is in the DOM right now.",
    "3. PHASE STATE — how the phase is driven (REQUIRED for playback to work). For each phase provide:",
    "   - `stateTarget`: a CSS selector for the ONE element whose class/attribute is toggled to drive the whole phase (e.g. the dropdown root, the `.modal`, the element with `[data-open]`). It MUST resolve in the live DOM RIGHT NOW, in any state — so it must NOT itself contain the toggled state (write `.t-morph`, never `.t-morph[data-open=\"true\"]`).",
    "   - `fromState` and `toState`: the class/attribute on `stateTarget` at the START and END of this phase, as a token: a class `\".is-open\"`, an attribute `\"[data-open=\\\"true\\\"]\"`, or `null`/`\"\"` for the base/no-class state. OPEN usually goes base→open (`fromState:null`, `toState:\".is-open\"`); CLOSE goes open→base (`fromState:\".is-open\"`, `toState:null`). Get the DIRECTION right — open must animate into the open look, close must animate back out.",
    "4. For each phase, list its MEMBER elements (panel, backdrop, the staggered items…). Give each member a stable `id`, a human `label`, a CSS `selector`, and its `propertyTimings`. For the phase that matches the current DOM, COPY each member's `propertyTimings` straight from the provided `raw.timings` (same per-property duration/delay/easing) — don't change numbers you were handed. The member `selector` MUST resolve in the live DOM RIGHT NOW regardless of phase — use the BASE element selector and do NOT bake the phase's toggled class/attribute into it (write `.t-morph .t-morph-plus`, never `.t-morph[data-open=\"true\"] .t-morph-plus`). The toggled state belongs only in the phase's `stateTarget`/`toState`.",
    "5. TIMINGS ARE PER-PROPERTY. For the OPPOSITE phase (from `cssRules`, or source if none): list one `propertyTimings` entry per animated property with its own duration/delay/easing; `cssRules` already have var() resolved, but if you ever read a raw `var(...)` resolve it to a concrete number, and convert `s`→ms (`0.25s`→250); never emit a `var(...)` or a guess. Open and close usually have DIFFERENT durations/easings. (The current-state phase just reuses the provided numbers.)",
    "",
    "Output ONLY a JSON object — no prose, no markdown fences — shaped exactly like:",
    '{"summary":"Grouped 3 components.","groups":[{"id":"dropdown","label":"Dropdown","component":"src/Dropdown.tsx","phases":[{"id":"dropdown:open","phase":"open","label":"Open","stateTarget":".dropdown","fromState":null,"toState":".is-open","members":[{"id":"panel","label":"Panel","selector":".dropdown .dropdown-panel","propertyTimings":[{"property":"opacity","durationMs":200,"delayMs":0,"easing":"ease-out"},{"property":"transform","durationMs":200,"delayMs":0,"easing":"cubic-bezier(0.22, 1, 0.36, 1)"}]}]},{"id":"dropdown:close","phase":"close","label":"Close","stateTarget":".dropdown","fromState":".is-open","toState":null,"members":[{"id":"panel","label":"Panel","selector":".dropdown .dropdown-panel","propertyTimings":[{"property":"opacity","durationMs":150,"delayMs":0,"easing":"ease-in"},{"property":"transform","durationMs":150,"delayMs":0,"easing":"ease-in"}]}]}]}]}',
    "If you cannot confidently group anything, return an empty groups array with a short summary; the panel keeps its flat DOM scan.",
  ].join("\n");
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
  const isApply = job.request?.kind === "apply";
  const isScan = job.request?.kind === "scan";
  const label = job.request?.label || job.request?.selector || "transition";
  // The browser picks the mode per job via the LLM / Deterministic tabs.
  // Default: LLM when a command is configured, otherwise deterministic.
  const mode = job.request?.mode || (AGENT_CMD ? "llm" : "deterministic");
  job.statusLog.push({
    message: isApply ? `Writing "${label}" to your code…` : isScan ? "Grouping transitions from your source…" : `Scanning "${label}"…`,
    at: now(),
  });
  try {
    let result;
    if (isApply) {
      // Editing source can only be done by the agent.
      if (!AGENT_CMD) {
        throw new Error(
          "Saving to your code needs the agent. Run `/refine live` in your editor, " +
            "or start the relay with REFINE_AGENT_CMD set."
        );
      }
      job.statusLog.push({ message: "Editing source files…", at: now() });
      result = await runAgentCmd(AGENT_CMD, buildApplyPrompt(job), parseApplyOutput);
      job.result = { applied: result.applied, summary: result.summary, files: result.files };
      job.status = "done";
      job.updatedAt = now();
      console.log(`  ✓ apply ${job.id.slice(0, 8)} — applied=${result.applied}`);
      return;
    }
    if (isScan) {
      // Reading source to group transitions can only be done by the agent.
      if (!AGENT_CMD) {
        throw new Error(
          "Grouping transitions needs the agent. Run `/refine live` in your editor, " +
            "or start the relay with REFINE_AGENT_CMD set."
        );
      }
      job.statusLog.push({ message: "Reading components from source…", at: now() });
      result = await runAgentCmd(withModel(AGENT_CMD, SCAN_MODEL), buildScanPrompt(job), parseScanOutput);
      job.result = { groups: result.groups, summary: result.summary };
      job.status = "done";
      job.updatedAt = now();
      console.log(`  ✓ scan ${job.id.slice(0, 8)} — ${result.groups.length} group(s)`);
      return;
    }
    if (mode === "llm") {
      if (!AGENT_CMD) {
        throw new Error(
          "LLM mode needs an agent CLI. Restart the relay with REFINE_AGENT_CMD set " +
            "(e.g. REFINE_AGENT_CMD='cursor-agent -p --trust --force' npm run relay), or switch to the Deterministic tab."
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
    // Apply and scan jobs read/edit source — agent only, never deterministic.
    const mode = (job.request.kind === "apply" || job.request.kind === "scan")
      ? "llm"
      : (job.request.mode || (llmAvailable() ? "llm" : "deterministic"));
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
      if (body && Array.isArray(body.suggestions)) {
        job.result = { suggestions: body.suggestions, summary: body.summary ?? null };
      } else if (body && Array.isArray(body.groups)) {
        // scan-job result from a `/refine live` agent
        job.result = { groups: body.groups, summary: body.summary ?? null };
      } else if (body && typeof body.applied !== "undefined") {
        // apply-job result from a `/refine live` agent
        job.result = { applied: Boolean(body.applied), summary: body.summary ?? null, files: Array.isArray(body.files) ? body.files : null };
      } else {
        return send(res, 400, { error: "Body must be { suggestions: [...] }, { groups: [...] }, or { applied, summary }" });
      }
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
