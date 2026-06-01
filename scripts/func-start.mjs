#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false });
}

const sync = run("node", ["scripts/sync-local-env.mjs"]);
if (sync.status !== 0) process.exit(sync.status ?? 1);

const func = run("func", ["start"]);
if (func.error?.code === "ENOENT" || func.status === 127) {
  console.error(`
Azure Functions Core Tools ("func") is not installed or not on your PATH.

macOS (Homebrew):
  brew tap azure/functions
  brew install azure-functions-core-tools@4

Other platforms:
  https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local
`);
  process.exit(1);
}

process.exit(func.status ?? 0);
