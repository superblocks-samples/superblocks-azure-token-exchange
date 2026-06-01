import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, decodeJwt } from "jose";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";

const cors = {
  "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
  "access-control-allow-methods": "OPTIONS,POST",
  "access-control-allow-headers": "authorization,content-type",
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
    body,
  };
}

function parseBody({ body, isBase64Encoded }) {
  if (!body) return {};
  const raw = isBase64Encoded
    ? Buffer.from(body, "base64").toString("utf8")
    : body;
  return Object.fromEntries(new URLSearchParams(raw));
}

function safeDecodeToken(token) {
  try {
    const header = decodeProtectedHeader(token);
    const claims = decodeJwt(token);
    return { header, claims };
  } catch {
    return { header: null, claims: null };
  }
}

function buildJwks(tenantId) {
  const v2 = new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
  const v1 = new URL(`https://login.microsoftonline.com/${tenantId}/discovery/keys`);
  return { primary: createRemoteJWKSet(v2), fallback: createRemoteJWKSet(v1) };
}

let _jwks;
function getJwks(tenantId) {
  if (!_jwks) _jwks = buildJwks(tenantId);
  return _jwks;
}

async function verify(token, tenantId, issuer, audience) {
  const opts = { issuer, audience, clockTolerance: "5s" };
  const { primary, fallback } = getJwks(tenantId);

  console.log("[verify] Attempting v2.0 JWKS:", `${tenantId}/discovery/v2.0/keys`);
  try {
    const result = await jwtVerify(token, primary, opts);
    console.log("[verify] Success with v2.0 keys");
    return result;
  } catch (err) {
    console.log("[verify] v2.0 failed:", err?.code, err?.message);
    console.log("[verify] Attempting v1 JWKS:", `${tenantId}/discovery/keys`);
    try {
      const result = await jwtVerify(token, fallback, opts);
      console.log("[verify] Success with v1 keys");
      return result;
    } catch (fallbackErr) {
      console.log("[verify] v1 also failed:", fallbackErr?.code, fallbackErr?.message);
      throw fallbackErr;
    }
  }
}

/**
 * Shared OAuth 2.0 token exchange handler (runtime-agnostic).
 * @param {{ method?: string, body?: string, isBase64Encoded?: boolean }} request
 * @returns {Promise<{ statusCode: number, headers: Record<string, string>, body: object | string }>}
 */
export async function handleTokenExchange({ method = "", body, isBase64Encoded = false }) {
  console.log("[handler] Method:", method);

  if (method.toUpperCase() === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  try {
    const tenantId = process.env.ENTRA_TENANT_ID;
    const audience = process.env.ENTRA_AUDIENCE;
    const issuer = process.env.ENTRA_ISSUER
      || `https://login.microsoftonline.com/${tenantId}/v2.0`;

    console.log("[config] tenantId:", tenantId);
    console.log("[config] audience:", audience);
    console.log("[config] issuer:", issuer);

    if (!tenantId || !audience) {
      console.error("[config] Missing ENTRA_TENANT_ID or ENTRA_AUDIENCE");
      return respond(500, { error: "server_error", error_description: "Missing ENTRA_TENANT_ID or ENTRA_AUDIENCE" });
    }

    const form = parseBody({ body, isBase64Encoded });
    console.log("[request] grant_type:", form.grant_type);
    console.log("[request] subject_token present:", !!form.subject_token);
    console.log("[request] subject_token_type:", form.subject_token_type);

    if (form.grant_type && form.grant_type !== GRANT_TYPE) {
      console.log("[request] Rejected: unsupported grant_type");
      return respond(400, { error: "unsupported_grant_type" });
    }

    const token = form.subject_token;
    if (!token) {
      console.log("[request] Rejected: no subject_token in body");
      return respond(400, { error: "invalid_request", error_description: "Missing subject_token" });
    }

    const { header, claims } = safeDecodeToken(token);
    console.log("[token] alg:", header?.alg, "kid:", header?.kid);
    console.log("[token] iss:", claims?.iss);
    console.log("[token] aud:", claims?.aud);
    console.log("[token] tid:", claims?.tid);
    console.log("[token] exp:", claims?.exp, "nbf:", claims?.nbf);
    console.log("[token] sub:", claims?.sub, "oid:", claims?.oid);

    const { payload } = await verify(token, tenantId, issuer, audience);

    if (payload.tid && payload.tid !== tenantId) {
      console.log("[validate] Tenant mismatch: token.tid =", payload.tid, "expected =", tenantId);
      return respond(401, { error: "invalid_token", error_description: "Tenant mismatch" });
    }

    const requiredScope = process.env.REQUIRED_SCOPE;
    if (requiredScope) {
      const requestedScopes = (form.scope || "").split(" ").filter(Boolean);
      console.log("[validate] Required scope:", requiredScope, "Requested scopes:", requestedScopes);
      if (!requestedScopes.includes(requiredScope)) {
        console.log("[validate] Rejected: request missing required scope");
        return respond(403, { error: "insufficient_scope" });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = typeof payload.exp === "number" ? Math.max(0, payload.exp - now) : 3600;

    console.log("[success] Returning validated token, expires_in:", expiresIn);
    return respond(200, {
      access_token: token,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: expiresIn,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const isJwtErr = err?.code?.startsWith("ERR_J") || /signature|issuer|audience|key/i.test(msg);
    console.error("[error]", isJwtErr ? "JWT" : "Server", "-", err?.code || "", msg);
    return respond(isJwtErr ? 401 : 500, {
      error: isJwtErr ? "invalid_token" : "server_error",
      error_description: msg,
    });
  }
}
