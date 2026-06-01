#!/usr/bin/env node
/**
 * Publish to an Azure Function App.
 * Installs prod deps, publishes, restores dev deps, and checks /api/health.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const functionApp = process.argv[2] || process.env.FUNCTION_APP;

if (!functionApp) {
  console.error("Usage: FUNCTION_APP=<name> npm run func:publish:azure");
  console.error("   or: node scripts/azure-publish.mjs <function-app>");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (result.status !== 0 && !opts.allowFail) {
    process.exit(result.status ?? 1);
  }
  return result;
}

console.log("=== Installing production dependencies ===");
run("npm", ["ci", "--omit=dev"]);

console.log("\n=== Publishing to Azure ===");
run("func", ["azure", "functionapp", "publish", functionApp]);

console.log("\n=== Restoring devDependencies ===");
run("npm", ["install"]);

const healthUrl = `https://${functionApp}.azurewebsites.net/api/health`;
console.log(`\n=== Testing ${healthUrl} ===`);
const curl = spawnSync("curl", ["-s", "-w", "\nHTTP %{http_code}\n", healthUrl], {
  encoding: "utf8",
});
console.log(curl.stdout || curl.stderr);

if (!String(curl.stdout).includes("HTTP 200")) {
  process.exit(1);
}
