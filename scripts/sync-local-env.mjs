#!/usr/bin/env node
/**
 * Generates local.settings.json for Azure Functions from env.local.json
 * (same file used by SAM for Lambda local runs).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, "env.local.json");
const outPath = join(root, "local.settings.json");

const SAM_FUNCTION = "TokenExchangeFunction";

const AZURE_DEFAULTS = {
  AzureWebJobsStorage: "UseDevelopmentStorage=true",
  FUNCTIONS_WORKER_RUNTIME: "node",
  AzureWebJobsFeatureFlags: "EnableWorkerIndexing",
};

if (!existsSync(envPath)) {
  console.error(`Missing ${envPath} — copy env.local.json.example and fill in your values.`);
  process.exit(1);
}

let env;
try {
  env = JSON.parse(readFileSync(envPath, "utf8"));
} catch (err) {
  console.error(`Failed to parse ${envPath}:`, err.message);
  process.exit(1);
}

const fnVars = env[SAM_FUNCTION];
if (!fnVars || typeof fnVars !== "object") {
  console.error(
    `${envPath} must include a "${SAM_FUNCTION}" object with your Entra settings (see env.local.json.example).`,
  );
  process.exit(1);
}

const settings = {
  IsEncrypted: false,
  Values: {
    ...AZURE_DEFAULTS,
    ...fnVars,
    ...(env._azure?.Values ?? {}),
  },
};

writeFileSync(outPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Wrote ${outPath} from ${envPath}`);
