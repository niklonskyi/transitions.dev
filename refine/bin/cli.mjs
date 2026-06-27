#!/usr/bin/env node
// Refine — transitions.dev live tool.
//
//   npx transitions-refine live         # inject the panel + start the relay
//   npx transitions-refine live --llm   # + install/wire cursor-agent (persistent LLM)
//   npx transitions-refine stop          # remove the injected <script> tag
//
// `live` sets up the timeline + Refine with no npm install and no source edits
// of your own:
//   1. injects one <script type="module" src=".../inject.js"> into your page
//   2. drops the `refine-live` + `transitions-dev` skills (for token-aware picks)
//   3. ensures an LLM backend:
//        --llm  → installs/wires the Cursor CLI (cursor-agent) so the relay
//                 answers LLM jobs itself, persistently (no /refine live loop).
//        else   → falls back to /refine live (in-IDE agent) + deterministic.
//   4. starts the local refine relay (serves the panel at /inject.js).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
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

// ── agent CLI (for the persistent LLM path) ──────────────────────────────────
// The relay spawns `REFINE_AGENT_CMD` per job. We point it at cursor-agent so
// LLM Refine works without a live `/refine live` loop. The binary may not be on
// the non-interactive PATH, so we probe known install locations and use an
// absolute path when wiring it up.
const AGENT_BIN_CANDIDATES = [
  "cursor-agent",
  join(HOME, ".local/bin/cursor-agent"),
  join(HOME, ".cursor/bin/cursor-agent"),
];

function isRunnable(bin) {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function findAgentBin() {
  return AGENT_BIN_CANDIDATES.find(isRunnable) || null;
}

function installAgentCli() {
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
  return findAgentBin();
}

// Returns an absolute-ish command string to put in REFINE_AGENT_CMD, or null.
function ensureAgentCli({ autoInstall }) {
  const bin = findAgentBin();
  if (bin) return bin;
  if (!autoInstall) return null;
  return installAgentCli();
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

  // 2.5) ensure an agent CLI so the relay can answer LLM jobs itself — this is
  //      the persistent path (no `/refine live` loop to keep alive). Installing
  //      fetches a system binary, so it only happens with explicit opt-in via
  //      `--llm`. If REFINE_AGENT_CMD is already set we respect it as-is.
  const wantLlm = Boolean(args.llm);
  const env = { ...process.env, REFINE_RELAY_PORT: port };
  let agentBin = null;
  if (process.env.REFINE_AGENT_CMD) {
    log(`✓ using REFINE_AGENT_CMD from environment: ${process.env.REFINE_AGENT_CMD}`);
  } else {
    agentBin = ensureAgentCli({ autoInstall: wantLlm });
    if (agentBin) {
      // Absolute path: the relay spawns via `sh -c`, whose PATH may not include
      // the CLI's install dir (e.g. ~/.local/bin). `-p` = headless print mode;
      // `--force` clears the workspace-trust / tool-approval prompts that would
      // otherwise hang a non-interactive spawn.
      const cmd = `${agentBin} -p --force`;
      env.REFINE_AGENT_CMD = cmd;
      log(`✓ LLM path wired: relay will spawn  ${cmd}`);
    }
  }

  // 3) start the relay (foreground; Ctrl-C stops it + reverts the injection)
  const relay = spawn(process.execPath, [join(PKG_ROOT, "server/relay.mjs")], {
    stdio: "inherit",
    env,
  });

  const llmWired = Boolean(env.REFINE_AGENT_CMD);
  log("");
  log("Next:");
  log("  1. Open your app — the timeline panel is now on the page.");
  log("  2. Click Refine. Deterministic suggestions work immediately.");
  if (llmWired) {
    log("  3. LLM suggestions are ON — the relay runs the agent CLI per click,");
    log("     so you never have to run /refine live.");
    log("     One-time: make sure the CLI is authenticated —");
    log("       run `cursor-agent` once to log in, or set CURSOR_API_KEY.");
  } else if (wantLlm) {
    log("  3. LLM was requested but cursor-agent isn't available (install failed).");
    log("     Install it manually, then re-run:");
    log("       curl https://cursor.com/install -fsS | bash");
    log("     …or run /refine live in your editor for the in-IDE-agent path.");
  } else {
    log("  3. For persistent LLM (no /refine live needed), re-run with --llm");
    log("     (installs the Cursor CLI once). Or run /refine live in your editor");
    log("     to use the in-IDE agent.");
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
  log("  npx transitions-refine live         # inject panel + start relay");
  log("  npx transitions-refine live --llm   # + install/wire cursor-agent for persistent LLM");
  log("  npx transitions-refine stop         # remove the injected tag");
  log("");
  log("Options: --page <html>  --port <n>  --llm (enable persistent LLM via the Cursor CLI)");
  process.exit(cmd ? 1 : 0);
}

main();
