#!/usr/bin/env node
/**
 * End-to-end Snowflake integration test:
 * 1. Exchange a subject_token via the token handler (HTTP or in-process)
 * 2. Connect to Snowflake with the returned access_token
 * 3. Run a simple identity query
 *
 * Usage:
 *   SUBJECT_TOKEN=eyJ... npm run test:snowflake
 *   SUBJECT_TOKEN=eyJ... npm run test:snowflake -- --direct
 *   npm run test:snowflake -- --subject-token eyJ...
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJwt } from "jose";
import snowflake from "snowflake-sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

function parseArgs(argv) {
  const args = { direct: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--direct") args.direct = true;
    else if (arg === "--subject-token") args.subjectToken = argv[++i];
    else if (arg === "--token-url") args.tokenUrl = argv[++i];
    else if (arg === "--snowflake-account") args.snowflakeAccount = argv[++i];
    else if (arg === "--snowflake-warehouse") args.snowflakeWarehouse = argv[++i];
    else if (arg === "--snowflake-role") args.snowflakeRole = argv[++i];
    else if (arg === "--snowflake-username") args.snowflakeUsername = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Snowflake integration test: token exchange → Snowflake OAuth

Required:
  SUBJECT_TOKEN              Entra access token (or --subject-token)
  SNOWFLAKE_ACCOUNT          Snowflake account identifier (or --snowflake-account)

Optional:
  TOKEN_EXCHANGE_URL         Default: http://localhost:7071/api/oauth2/token
  SNOWFLAKE_WAREHOUSE        Warehouse for the test query
  SNOWFLAKE_ROLE             Snowflake role (optional; omit with session:role-any in token)
  SNOWFLAKE_USERNAME         Snowflake login name (optional; omit for OAuth — user comes from token)
  --direct                   Invoke handler in-process (uses env.local.json)
  --token-url <url>
  --snowflake-account <id>
  --snowflake-warehouse <name>
  --snowflake-role <name>

Config file (optional): env.integration.json — see env.integration.json.example
Local handler env (for --direct): env.local.json TokenExchangeFunction block

Examples:
  SUBJECT_TOKEN=eyJ... SNOWFLAKE_ACCOUNT=xy12345.us-east-1 npm run test:snowflake
  SUBJECT_TOKEN=eyJ... npm run test:snowflake -- --direct
`);
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadConfig() {
  const integration = loadJson(join(root, "env.integration.json")) ?? {};
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  return {
    direct: args.direct,
    subjectToken: args.subjectToken || process.env.SUBJECT_TOKEN || integration.SUBJECT_TOKEN,
    tokenUrl:
      args.tokenUrl
      || process.env.TOKEN_EXCHANGE_URL
      || integration.TOKEN_EXCHANGE_URL
      || "http://localhost:7071/api/oauth2/token",
    snowflakeAccount:
      args.snowflakeAccount
      || process.env.SNOWFLAKE_ACCOUNT
      || integration.SNOWFLAKE_ACCOUNT,
    snowflakeWarehouse:
      args.snowflakeWarehouse
      || process.env.SNOWFLAKE_WAREHOUSE
      || integration.SNOWFLAKE_WAREHOUSE,
    snowflakeRole:
      args.snowflakeRole
      || process.env.SNOWFLAKE_ROLE
      || integration.SNOWFLAKE_ROLE,
    snowflakeUsername:
      args.snowflakeUsername
      || process.env.SNOWFLAKE_USERNAME
      || integration.SNOWFLAKE_USERNAME,
  };
}

function applyFunctionEnv(envLocal) {
  const vars = envLocal?.TokenExchangeFunction ?? {};
  for (const [key, value] of Object.entries(vars)) {
    if (value !== "" && process.env[key] === undefined) {
      process.env[key] = String(value);
    }
  }
}

function logTokenClaims(label, token) {
  try {
    const claims = decodeJwt(token);
    console.log(`[${label}] iss:`, claims.iss);
    console.log(`[${label}] aud:`, claims.aud);
    console.log(`[${label}] exp:`, claims.exp);
    console.log(`[${label}] email:`, claims.email ?? "(missing)");
    console.log(`[${label}] scp:`, claims.scp ?? claims.scope ?? "(missing)");
    return claims;
  } catch (err) {
    console.log(`[${label}] Could not decode JWT:`, err.message);
    return null;
  }
}

function safeDecodeClaims(token) {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

function extractTenantId(claims) {
  if (claims?.tid) return claims.tid;

  const iss = claims?.iss ?? "";
  const stsMatch = iss.match(/https:\/\/sts\.windows\.net\/([^/]+)\/?/i);
  if (stsMatch) return stsMatch[1];

  const v2Match = iss.match(/https:\/\/login\.microsoftonline\.com\/([^/]+)\//i);
  if (v2Match) return v2Match[1];

  const envLocal = loadJson(join(root, "env.local.json"));
  return envLocal?.TokenExchangeFunction?.ENTRA_TENANT_ID ?? "<tenant-id>";
}

function formatAudience(aud) {
  if (Array.isArray(aud)) return aud.map((v) => `'${v}'`).join(", ");
  if (aud) return `'${aud}'`;
  return "'api://<client-id>'";
}

function getTokenScope(claims) {
  return claims?.scp ?? claims?.scope ?? "";
}

function parseScopeTokens(scope) {
  if (!scope) return [];
  return String(scope).split(/\s+/).filter(Boolean);
}

function validateSnowflakeScope(claims) {
  const scope = getTokenScope(claims);
  const tokens = parseScopeTokens(scope);

  if (tokens.length === 0) {
    return {
      valid: false,
      message: "Missing scp/scope claim — Snowflake requires session:role-any or session:role:<ROLE>.",
    };
  }

  const hasValidScope = tokens.some(
    (token) => /^session:role-any$/i.test(token) || /^session:role:[A-Za-z0-9_]+$/i.test(token),
  );

  if (!hasValidScope) {
    return {
      valid: false,
      message: `Invalid scp/scope "${scope}" — expected session:role-any or session:role:<ROLE>.`,
    };
  }

  return { valid: true, scope };
}

function assertSnowflakeScope(claims, label) {
  const result = validateSnowflakeScope(claims);
  if (result.valid) return;

  console.error(`\n[${label}] ${result.message}`);
  console.error(`
Request a Snowflake OAuth scope when users sign in via Entra / Superblocks SSO, e.g.:
  https://<account>.snowflakecomputing.com/session:role-any
  https://<account>.snowflakecomputing.com/session:role:<ROLE>

See https://docs.snowflake.com/en/user-guide/oauth-azure
`);
  process.exit(1);
}

function formatSnowflakeError(err) {
  const parts = [err?.message];
  if (err?.code) parts.push(`code=${err.code}`);
  if (err?.sqlState) parts.push(`sqlState=${err.sqlState}`);
  if (err?.data?.uuid) parts.push(`uuid=${err.data.uuid}`);
  if (err?.data?.message) parts.push(err.data.message);
  return parts.filter(Boolean).join(" | ");
}

function buildIntegrationContext(claims, config) {
  const tenantId = extractTenantId(claims);
  return {
    issuer: claims?.iss ?? `https://sts.windows.net/${tenantId}/`,
    audience: formatAudience(claims?.aud),
    jwksUrl: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    email: claims?.email ?? "<email-from-token>",
    integrationName: "external_oauth_superblocks_entra",
    userMappingClaim: claims?.email ? "email" : "upn",
    userMappingAttribute: "LOGIN_NAME",
    roleNote: config.snowflakeRole
      ? `Token scope should include: session:role:${config.snowflakeRole.toUpperCase()}`
      : "Token scope should include session:role-any or session:role:<ROLE>",
  };
}

function printFailureHelp(accessToken, config, err) {
  const claims = safeDecodeClaims(accessToken);
  const scope = getTokenScope(claims) || "(missing)";
  const uuid = err?.data?.uuid;
  const ctx = buildIntegrationContext(claims, config);
  const loginName = config.snowflakeUsername
    || (claims?.email ? String(claims.email).toUpperCase() : "<LOGIN_NAME>");
  const auth390100 = err?.code === "390100"
    ? `
Error 390100 is Snowflake's generic OAuth login failure — not a password issue. Common causes:
  - No Snowflake user matches the token email/login mapping
  - User exists but lacks the requested role (${config.snowflakeRole || "from token scope"})
  - Wrong SNOWFLAKE_ACCOUNT locator
  - Do not pass username to the driver unless it matches LOGIN_NAME exactly (see SNOWFLAKE_USERNAME)
`
    : "";

  console.error(`${auth390100}
Troubleshooting:

  email:   ${ctx.email}
  scp:     ${scope}
  account: ${config.snowflakeAccount}

VERIFY validates the token (iss/aud/signature). Login also needs a mapped Snowflake user,
valid role scope, and role/warehouse grants.

1) Verify token and user mapping (check the "User" field matches LOGIN_NAME):

  SELECT SYSTEM$VERIFY_EXTERNAL_OAUTH_TOKEN('<paste_access_token>');

2) Security integration (EXTERNAL_OAUTH_TYPE = AZURE):

  CREATE OR REPLACE SECURITY INTEGRATION ${ctx.integrationName}
    TYPE = EXTERNAL_OAUTH
    ENABLED = TRUE
    EXTERNAL_OAUTH_TYPE = AZURE
    EXTERNAL_OAUTH_ISSUER = '${ctx.issuer}'
    EXTERNAL_OAUTH_JWS_KEYS_URL = '${ctx.jwksUrl}'
    EXTERNAL_OAUTH_AUDIENCE_LIST = (${ctx.audience})
    EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = '${ctx.userMappingClaim}'
    EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = '${ctx.userMappingAttribute}'
    EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';

  ${ctx.roleNote}

  ALTER SECURITY INTEGRATION ${ctx.integrationName} SET
    EXTERNAL_OAUTH_ISSUER = '${ctx.issuer}',
    EXTERNAL_OAUTH_JWS_KEYS_URL = '${ctx.jwksUrl}',
    EXTERNAL_OAUTH_AUDIENCE_LIST = (${ctx.audience}),
    EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = '${ctx.userMappingClaim}',
    EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = '${ctx.userMappingAttribute}',
    EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';

  DESC SECURITY INTEGRATION ${ctx.integrationName};

  Issuer must match token iss exactly (decode at jwt.ms).

3) Snowflake user, role, and integration grants:

  SELECT NAME, LOGIN_NAME, EMAIL FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
    WHERE EMAIL ILIKE '${ctx.email}' OR LOGIN_NAME ILIKE '${ctx.email}';

  CREATE USER IF NOT EXISTS "${ctx.email}" EMAIL = '${ctx.email}' LOGIN_NAME = '${ctx.email}';
  GRANT ROLE ${config.snowflakeRole || "<role>"} TO USER "${ctx.email}";
  GRANT USAGE ON INTEGRATION ${ctx.integrationName} TO ROLE ${config.snowflakeRole || "<role>"};
  GRANT USAGE ON WAREHOUSE ${config.snowflakeWarehouse || "<warehouse>"} TO ROLE ${config.snowflakeRole || "<role>"};

4) Test outside the SDK (note -u matches LOGIN_NAME, not lowercase email):

  snowsql -a ${config.snowflakeAccount} -u ${loginName} --authenticator oauth \\
    --token "<access_token>" -w ${config.snowflakeWarehouse || "<warehouse>"} \\
    -q "SELECT CURRENT_USER(), CURRENT_ROLE();"
${uuid ? `
5) Login failure details (admin with MONITOR):

  SELECT SYSTEM$GET_LOGIN_FAILURE_DETAILS('${uuid}');
` : `
5) If the error includes a UUID (admin with MONITOR):

  SELECT SYSTEM$GET_LOGIN_FAILURE_DETAILS('<uuid-from-error>');
`}

Docs: https://docs.snowflake.com/en/user-guide/oauth-azure
`);
}

async function exchangeViaHttp(tokenUrl, subjectToken) {
  console.log("[exchange] POST", tokenUrl);
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE,
    subject_token_type: SUBJECT_TOKEN_TYPE,
    subject_token: subjectToken,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${payload.error_description || payload.error || res.statusText}`,
    );
  }
  if (!payload.access_token) {
    throw new Error("Token exchange response missing access_token");
  }
  return payload.access_token;
}

async function exchangeDirect(subjectToken) {
  const envLocal = loadJson(join(root, "env.local.json"));
  if (!envLocal) {
    throw new Error("Missing env.local.json — required for --direct mode");
  }
  applyFunctionEnv(envLocal);

  const { handleTokenExchange } = await import("../lib/token-exchange.js");
  const rawBody = new URLSearchParams({
    grant_type: GRANT_TYPE,
    subject_token_type: SUBJECT_TOKEN_TYPE,
    subject_token: subjectToken,
  }).toString();

  console.log("[exchange] In-process handleTokenExchange()");
  const result = await handleTokenExchange({ method: "POST", body: rawBody });
  const payload = typeof result.body === "string" ? JSON.parse(result.body) : result.body;

  if (result.statusCode !== 200) {
    throw new Error(
      `Token exchange failed (${result.statusCode}): ${payload.error_description || payload.error}`,
    );
  }
  if (!payload.access_token) {
    throw new Error("Token exchange response missing access_token");
  }
  return payload.access_token;
}

function resolveSnowflakeUsername(config, claims) {
  if (config.snowflakeUsername) return config.snowflakeUsername;
  // Snowflake LOGIN_NAME is typically uppercase; drivers/snowsql require -u to match it.
  if (claims?.email) return String(claims.email).toUpperCase();
  return undefined;
}

function connectSnowflake(config, accessToken, claims) {
  snowflake.configure({ logLevel: "ERROR" });

  const username = resolveSnowflakeUsername(config, claims);
  const connectionConfig = {
    account: config.snowflakeAccount,
    authenticator: "OAUTH",
    token: accessToken,
  };
  if (username) connectionConfig.username = username;
  if (config.snowflakeWarehouse) connectionConfig.warehouse = config.snowflakeWarehouse;
  if (config.snowflakeRole) connectionConfig.role = config.snowflakeRole;

  console.log("[snowflake] account:", config.snowflakeAccount);
  console.log("[snowflake] username:", username ?? "(not set — snowsql/drivers usually need LOGIN_NAME)");
  if (connectionConfig.warehouse) console.log("[snowflake] warehouse:", connectionConfig.warehouse);
  if (connectionConfig.role) console.log("[snowflake] role:", connectionConfig.role);

  return new Promise((resolve, reject) => {
    const connection = snowflake.createConnection(connectionConfig);
    connection.connect((err, conn) => {
      if (err) reject(err);
      else resolve(conn);
    });
  });
}

function executeSql(connection, sqlText) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      complete(err, _stmt, rows) {
        if (err) reject(err);
        else resolve(rows);
      },
    });
  });
}

function destroyConnection(connection) {
  return new Promise((resolve) => {
    connection.destroy((err) => {
      if (err) console.warn("[snowflake] disconnect warning:", err.message);
      resolve();
    });
  });
}

async function main() {
  const config = loadConfig();

  if (!config.subjectToken) {
    console.error("Missing SUBJECT_TOKEN (env, env.integration.json, or --subject-token)\n");
    printHelp();
    process.exit(1);
  }
  if (!config.snowflakeAccount) {
    console.error("Missing SNOWFLAKE_ACCOUNT (env, env.integration.json, or --snowflake-account)\n");
    printHelp();
    process.exit(1);
  }

  if (!config.snowflakeAccount || config.snowflakeAccount.includes("YOUR_ACCOUNT")) {
    console.error("Set SNOWFLAKE_ACCOUNT in env.integration.json to your account locator (Admin → Accounts).\n");
    printHelp();
    process.exit(1);
  }

  console.log("=== Token exchange → Snowflake integration test ===\n");
  const subjectClaims = logTokenClaims("subject_token", config.subjectToken);
  assertSnowflakeScope(subjectClaims, "subject_token");

  const accessToken = config.direct
    ? await exchangeDirect(config.subjectToken)
    : await exchangeViaHttp(config.tokenUrl, config.subjectToken);

  console.log("\n[exchange] Received access_token");
  const accessClaims = logTokenClaims("access_token", accessToken);
  assertSnowflakeScope(accessClaims, "access_token");

  let connection;
  try {
    console.log("\n[snowflake] Connecting with OAuth token...");
    connection = await connectSnowflake(config, accessToken, accessClaims);

    const rows = await executeSql(
      connection,
      "SELECT CURRENT_USER() AS user, CURRENT_ROLE() AS role, CURRENT_WAREHOUSE() AS warehouse",
    );

    console.log("\n[snowflake] Query succeeded:");
    console.log(rows);

    console.log("\n=== Integration test passed ===");
  } catch (err) {
    console.error("\n[snowflake] Connection or query failed:", formatSnowflakeError(err));
    printFailureHelp(accessToken, config, err);
    process.exit(1);
  } finally {
    if (connection) await destroyConnection(connection);
  }
}

main().catch((err) => {
  console.error("\n[error]", err.message);
  process.exit(1);
});
