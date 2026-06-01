#!/usr/bin/env node
/**
 * Publish to Azure Functions and fix Linux Consumption settings.
 *
 * func publish sets WEBSITE_MOUNT_ENABLED=1, which breaks run-from-package on Linux.
 * Sync triggers often fails during publish even when deploy succeeds — we fix settings
 * and verify the endpoint afterward.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const functionApp = process.argv[2] || process.env.FUNCTION_APP;
const resourceGroup = process.argv[3] || process.env.RESOURCE_GROUP || "superblocks-token-exchange-rg";

if (!functionApp) {
  console.error("Usage: FUNCTION_APP=<name> npm run func:publish:azure");
  console.error("   or: node scripts/azure-publish.mjs <function-app> [resource-group]");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (result.status !== 0 && !opts.allowFail) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function subscriptionId() {
  const result = spawnSync("az", ["account", "show", "--query", "id", "-o", "tsv"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("Failed to read Azure subscription. Run: az login");
    process.exit(1);
  }
  return result.stdout.trim();
}

console.log("=== Installing production dependencies ===");
run("npm", ["ci", "--omit=dev"]);

console.log("\n=== Publishing to Azure (sync may fail; continuing) ===");
const publish = run("func", ["azure", "functionapp", "publish", functionApp], { allowFail: true });

console.log("\n=== Removing WEBSITE_MOUNT_ENABLED (Linux Consumption + run-from-package) ===");
run("az", [
  "functionapp", "config", "appsettings", "delete",
  "--resource-group", resourceGroup,
  "--name", functionApp,
  "--setting-names", "WEBSITE_MOUNT_ENABLED",
]);

console.log("\n=== Ensuring v4 worker indexing ===");
run("az", [
  "functionapp", "config", "appsettings", "set",
  "--resource-group", resourceGroup,
  "--name", functionApp,
  "--settings", "AzureWebJobsFeatureFlags=EnableWorkerIndexing",
]);

console.log("\n=== Restarting function app ===");
run("az", ["functionapp", "restart", "--resource-group", resourceGroup, "--name", functionApp]);

console.log("\nWaiting 60s for host startup...");
spawnSync("sleep", ["60"], { stdio: "inherit" });

console.log("\n=== Syncing triggers ===");
const subId = subscriptionId();
const sync = run("az", [
  "rest", "--method", "POST",
  "--uri",
  `https://management.azure.com/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionApp}/syncfunctiontriggers?api-version=2022-03-01`,
], { allowFail: true });

const testUrl = `https://${functionApp}.azurewebsites.net/api/health`;
console.log(`\n=== Testing ${testUrl} ===`);
const curl = spawnSync("curl", ["-s", "-w", "\nHTTP %{http_code}\n", testUrl], {
  encoding: "utf8",
});
console.log(curl.stdout || curl.stderr);

if (publish.status !== 0) {
  console.warn("\nNote: func publish reported sync-triggers error. This is common on Linux Consumption.");
  console.warn("If health returns 200 above, the deploy succeeded.");
}
if (sync.status !== 0) {
  console.warn("Note: manual sync triggers failed. If health returns 200, you are OK.");
}

if (!String(curl.stdout).includes("HTTP 200")) {
  process.exit(1);
}
