#!/usr/bin/env node
// Generate refine/.agents/skills/transitions-dev from the repo's canonical
// skill (../../skills/transitions-dev) so the published tarball is
// self-contained. Run automatically via `prepack`; the generated copy is
// gitignored to avoid keeping two copies in version control.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = dirname(PKG_ROOT);

const src = join(REPO_ROOT, "skills", "transitions-dev");
const dest = join(PKG_ROOT, ".agents", "skills", "transitions-dev");

if (!existsSync(src)) {
  console.error(`! canonical skill not found at ${src}`);
  console.error("  (run this from within the transitions.dev repo)");
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`✓ synced transitions-dev skill → ${dest.replace(PKG_ROOT, "refine")}`);
