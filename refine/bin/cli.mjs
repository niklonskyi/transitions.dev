#!/usr/bin/env node
// Refine — transitions.dev live tool.
//
//   npx transitions-refine live              # inject panel + relay; auto-wire your agent CLI
//   npx transitions-refine live --agent claude   # force an agent: cursor | claude | codex
//   npx transitions-refine live --llm        # install the Cursor CLI if no agent is found
//   npx transitions-refine stop              # remove the injected <script> tag
//
// `live` sets up the timeline + Refine with no npm install and no source edits
// of your own:
//   1. injects one <script type="module" src=".../inject.js"> into your page
//   2. drops the `refine-live` + `transitions-dev` skills (for token-aware picks)
//   3. wires an LLM backend so the relay answers jobs itself, persistently (no
//      /refine live loop). It prefers the agent HOSTING this run — Cursor →
//      cursor-agent, Claude Code → claude, Codex → codex — so Refine uses the
//      subscription you already have. Override with --agent <name> or by
//      exporting REFINE_AGENT_CMD. With no agent available it falls back to the
//      /refine live in-IDE loop (and --llm can install the Cursor CLI).
//   4. starts the local refine relay (serves the panel at /inject.js).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CWD = process.cwd();
const HOME = process.env.HOME || homedir();
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version || "0";
  } catch {
    return "0";
  }
})();

const MARK_START = "<!-- timeline-inject:start -->";
const MARK_END = "<!-- timeline-inject:end -->";
const PAGE_CANDIDATES = [
  "index.html",
  "public/index.html",
  "src/index.html",
  "app/index.html",
  "dist/index.html",
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--page" || a === "-p") args.page = argv[++i];
    else if (a === "--port") args.port = argv[++i];
    else if (a === "--agent") args.agent = argv[++i];
    else if (a.startsWith("--")) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function findPage(explicit) {
  if (explicit) return resolve(CWD, explicit);
  for (const c of PAGE_CANDIDATES) {
    const p = join(CWD, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function injectTag(pagePath, port) {
  const tag = `${MARK_START}\n<script type="module" src="http://localhost:${port}/inject.js"></script>\n${MARK_END}`;
  let html = readFileSync(pagePath, "utf8");
  if (html.includes(MARK_START)) {
    html = stripTag(html); // refresh (e.g. port changed)
  }
  if (html.includes("</body>")) {
    html = html.replace(/<\/body>/i, `${tag}\n</body>`);
  } else {
    html += `\n${tag}\n`;
  }
  writeFileSync(pagePath, html);
}

function stripTag(html) {
  const re = new RegExp(`\\n?${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}\\n?`, "g");
  return html.replace(re, "");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Copy a whole skill directory from the package into the user's project so the
// in-IDE agent (/refine live) and any spawned cursor-agent can read it.
//
// Crucially this REFRESHES a stale copy on upgrade. An older installed skill can
// shadow newer job handling — e.g. a pre-scan `refine-live` skill that doesn't
// know how to answer kind:"scan" jobs, so scan jobs time out and the panel hangs
// on "Agent is scanning…". We stamp the package version into the skill dir and
// re-copy whenever it's missing or mismatched (so we don't clobber every run).
function dropSkill(name) {
  const src = join(PKG_ROOT, ".agents/skills", name);
  const destDir = join(CWD, ".agents/skills", name);
  if (!existsSync(src)) return false;
  const marker = join(destDir, ".refine-version");
  const existed = existsSync(destDir);
  if (existed) {
    let installed = null;
    try { installed = readFileSync(marker, "utf8").trim(); } catch {}
    if (installed === PKG_VERSION) return "exists";
  }
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(src, destDir, { recursive: true, force: true });
  try { writeFileSync(marker, PKG_VERSION + "\n"); } catch {}
  return existed ? "updated" : true;
}

// ── agent CLIs (for the persistent LLM path) ─────────────────────────────────
// The relay answers LLM jobs by spawning REFINE_AGENT_CMD per job (stdin =
// prompt, stdout = JSON). To bill against the account the user ALREADY pays for,
// we detect which agent is hosting this run and wire ITS CLI: a Claude Code user
// gets `claude`, a Codex user gets `codex`, a Cursor user gets `cursor-agent`.
// Detection is by each host's env markers; override with --agent <name> or by
// exporting REFINE_AGENT_CMD yourself.
const envHasPrefix = (p) => Object.keys(process.env).some((k) => k.startsWith(p));

const AGENTS = [
  {
    key: "cursor",
    label: "Cursor",
    // Cursor's agent terminal exports CURSOR_AGENT.
    host: () => Boolean(process.env.CURSOR_AGENT),
    bins: [
      "cursor-agent",
      join(HOME, ".local/bin/cursor-agent"),
      join(HOME, ".cursor/bin/cursor-agent"),
    ],
    // -p = headless/stdin, --force = auto-allow tool calls. The relay also
    // auto-appends -p/--trust/--force for cursor-agent; we wire them up front so
    // the printed command is the real one.
    cmd: (bin) => `${bin} -p --force`,
    canInstall: true,
    auth: "run `cursor-agent` once to log in, or set CURSOR_API_KEY",
  },
  {
    key: "claude",
    label: "Claude Code",
    // Claude Code exports CLAUDECODE=1 (+ CLAUDE_CODE_*) in its tools/terminals.
    host: () => Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT),
    bins: [
      "claude",
      join(HOME, ".claude/local/claude"),
      join(HOME, ".local/bin/claude"),
    ],
    // -p = headless print (prompt on stdin); skip-permissions so apply jobs can
    // edit files without an interactive approval prompt.
    cmd: (bin) => `${bin} -p --dangerously-skip-permissions`,
    canInstall: false,
    auth: "run `claude` once to sign in",
  },
  {
    key: "codex",
    label: "Codex",
    // Codex exec exports CODEX_SANDBOX (+ CODEX_* friends) in its sandbox.
    host: () => Boolean(process.env.CODEX_SANDBOX) || envHasPrefix("CODEX_"),
    bins: ["codex", join(HOME, ".local/bin/codex")],
    // `codex exec -` reads the prompt on stdin; workspace-write so apply jobs can
    // edit files; skip-git-repo-check so a non-git project root doesn't error out.
    cmd: (bin) => `${bin} exec --sandbox workspace-write --skip-git-repo-check -`,
    canInstall: false,
    auth: "run `codex` once to sign in, or set CODEX_API_KEY",
  },
];

// Host-detection precedence. Claude/Codex export very specific markers; check
// them BEFORE Cursor so a Claude Code or Codex session launched from inside a
// Cursor terminal (which still carries CURSOR_*) is not mis-wired to cursor-agent.
const HOST_PRECEDENCE = ["claude", "codex", "cursor"];

function isRunnable(bin) {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function findBin(agent) {
  return agent.bins.find(isRunnable) || null;
}

function detectHostAgent() {
  for (const key of HOST_PRECEDENCE) {
    const a = AGENTS.find((x) => x.key === key);
    if (a && a.host()) return a;
  }
  return null;
}

// Install the Cursor CLI (the only agent we can fetch non-interactively).
function installCursorCli() {
  log("• installing the Cursor CLI (cursor-agent) — one-time…");
  const r =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-Command", "irm 'https://cursor.com/install?win32=true' | iex"],
          { stdio: "inherit" }
        )
      : spawnSync("sh", ["-c", "curl https://cursor.com/install -fsS | bash"], {
          stdio: "inherit",
        });
  if (r.status !== 0) log("! the installer exited non-zero — see its output above.");
  return findBin(AGENTS[0]);
}

// Decide which agent CLI the relay should spawn. Returns either
//   { cmd, agent, source }          → wire this command (persistent LLM), or
//   { cmd:null, agent?, reason }    → couldn't wire; caller prints guidance.
// Precedence: explicit REFINE_AGENT_CMD → --agent <key> → host agent (same
// subscription) → any installed agent → (with --llm) install cursor-agent.
function resolveAgent({ wantLlm, forceKey }) {
  if (process.env.REFINE_AGENT_CMD) {
    return { cmd: process.env.REFINE_AGENT_CMD, source: "env" };
  }

  let target = null;
  if (forceKey) {
    target = AGENTS.find((a) => a.key === forceKey) || null;
    if (!target) {
      return { cmd: null, reason: `unknown --agent "${forceKey}" (use cursor | claude | codex)` };
    }
  }
  if (!target) target = detectHostAgent();

  if (target) {
    let bin = findBin(target);
    if (!bin && target.canInstall && wantLlm) bin = installCursorCli();
    if (bin) return { cmd: target.cmd(bin), agent: target, source: forceKey ? "forced" : "host" };
    return {
      cmd: null,
      agent: target,
      reason:
        `detected ${target.label} but its CLI isn't on PATH` +
        (target.canInstall ? " — re-run with --llm to install it" : ` — install the ${target.label} CLI first`),
    };
  }

  // No host detected (plain terminal): use any installed agent, in list order.
  for (const a of AGENTS) {
    const bin = findBin(a);
    if (bin) return { cmd: a.cmd(bin), agent: a, source: "scan" };
  }

  // Nothing installed: only cursor-agent can be fetched non-interactively.
  if (wantLlm) {
    const bin = installCursorCli();
    if (bin) return { cmd: AGENTS[0].cmd(bin), agent: AGENTS[0], source: "install" };
  }
  return { cmd: null, reason: "no agent CLI found" };
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function cmdLive(args) {
  const port = String(args.port || process.env.REFINE_RELAY_PORT || 7331);
  const page = findPage(args.page);

  // 1) inject the script tag
  if (page) {
    injectTag(page, port);
    log(`✓ injected timeline into ${page.replace(CWD + "/", "")}`);
  } else {
    log("! no HTML entry found (looked for index.html, public/index.html, …).");
    log("  Add this one line to your page <body> yourself:");
    log(`    <script type="module" src="http://localhost:${port}/inject.js"></script>`);
    log("  …or re-run with --page <path-to-your-html>.");
  }

  // 2) drop the skills the Refine flow relies on (the in-IDE agent and any
  //    spawned cursor-agent both read transitions-dev for token-aware picks).
  for (const name of ["refine-live", "transitions-dev"]) {
    const r = dropSkill(name);
    if (r === true) log(`✓ added .agents/skills/${name}`);
    else if (r === "updated") log(`✓ updated .agents/skills/${name} (now v${PKG_VERSION})`);
    else if (r === "exists") log(`✓ ${name} skill already present (v${PKG_VERSION})`);
  }

  // 2.5) wire an agent CLI so the relay can answer LLM jobs itself — the
  //      persistent path (no `/refine live` loop to keep alive). We prefer the
  //      agent hosting this run so Refine bills the subscription the user already
  //      has. REFINE_AGENT_CMD (if set) always wins; --agent forces a choice.
  const wantLlm = Boolean(args.llm);
  const forceKey = typeof args.agent === "string" ? args.agent : null;
  const env = { ...process.env, REFINE_RELAY_PORT: port };
  const resolved = resolveAgent({ wantLlm, forceKey });
  if (resolved.cmd) {
    env.REFINE_AGENT_CMD = resolved.cmd;
    if (resolved.source === "env") {
      log(`✓ using REFINE_AGENT_CMD from environment: ${resolved.cmd}`);
    } else {
      const via =
        resolved.source === "host" ? `detected ${resolved.agent.label}`
        : resolved.source === "forced" ? `forced ${resolved.agent.label}`
        : resolved.source === "scan" ? `found ${resolved.agent.label}`
        : `installed ${resolved.agent.label}`;
      log(`✓ LLM path wired (${via}): relay will spawn  ${resolved.cmd}`);
    }
  } else if (resolved.reason) {
    log(`• LLM not wired — ${resolved.reason}.`);
  }

  // 3) start the relay (foreground; Ctrl-C stops it + reverts the injection)
  const relay = spawn(process.execPath, [join(PKG_ROOT, "server/relay.mjs")], {
    stdio: "inherit",
    env,
  });

  const llmWired = Boolean(env.REFINE_AGENT_CMD);
  const authHint = resolved.agent && resolved.agent.auth;
  log("");
  log("Next:");
  log("  1. Open your app — the timeline panel is now on the page.");
  log("  2. Click Refine. Deterministic suggestions work immediately.");
  if (llmWired) {
    log("  3. LLM suggestions are ON — the relay runs the agent CLI per click,");
    log("     so you never have to run /refine live.");
    if (authHint) log(`     One-time: make sure the CLI is authenticated — ${authHint}.`);
  } else {
    log("  3. No agent CLI wired, so LLM features need a live answerer. Either:");
    log("     • run /refine live in your editor (Cursor / Claude Code / Codex), or");
    log("     • re-run with --llm to install the Cursor CLI, or");
    log("     • export REFINE_AGENT_CMD='<your agent CLI>' and re-run.");
  }
  log("");
  log("Press Ctrl-C to stop the relay and remove the injected tag.");

  const cleanup = () => {
    try {
      if (page && existsSync(page)) {
        const html = stripTag(readFileSync(page, "utf8"));
        writeFileSync(page, html);
        log(`\n✓ removed injected tag from ${page.replace(CWD + "/", "")}`);
      }
    } catch {}
    if (!relay.killed) relay.kill("SIGINT");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  relay.on("exit", (code) => process.exit(code ?? 0));
}

function cmdStop(args) {
  const page = findPage(args.page);
  if (!page || !existsSync(page)) {
    log("! no HTML entry found to clean. Pass --page <path> if needed.");
    return;
  }
  const html = readFileSync(page, "utf8");
  if (!html.includes(MARK_START)) {
    log(`nothing to remove in ${page.replace(CWD + "/", "")}`);
    return;
  }
  writeFileSync(page, stripTag(html));
  log(`✓ removed injected tag from ${page.replace(CWD + "/", "")}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "live";
  if (cmd === "live") return cmdLive(args);
  if (cmd === "stop") return cmdStop(args);
  log("Refine — transitions.dev live tool");
  log("  npx transitions-refine live                 # inject panel + relay; auto-wire your agent CLI");
  log("  npx transitions-refine live --agent claude  # force an agent: cursor | claude | codex");
  log("  npx transitions-refine live --llm           # install the Cursor CLI if no agent is found");
  log("  npx transitions-refine stop                 # remove the injected tag");
  log("");
  log("Options: --page <html>  --port <n>  --agent <cursor|claude|codex>  --llm");
  log("It prefers the agent hosting this run (Cursor/Claude Code/Codex) so Refine uses");
  log("the subscription you already have. Or set REFINE_AGENT_CMD to wire any CLI.");
  process.exit(cmd ? 1 : 0);
}

// Run only when invoked as the CLI entry (npx / node bin/cli.mjs), so tests can
// import the resolver helpers without triggering a live run.
// Run only when invoked as the CLI entry (npx / global install / node bin/cli.mjs).
// We must resolve symlinks: npx and global installs invoke this via a `.bin/refine`
// symlink, so process.argv[1] is the symlink path while import.meta.url is the real
// file. Comparing raw paths fails through the symlink and silently skips main().
function isCliEntry() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const resolve = (p) => {
    try { return realpathSync(p); } catch { return p; }
  };
  return resolve(process.argv[1]) === resolve(self);
}
if (isCliEntry()) {
  main();
}

export { AGENTS, HOST_PRECEDENCE, detectHostAgent, resolveAgent, findBin };
