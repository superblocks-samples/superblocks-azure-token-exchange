# Internal API setup

Use this guide when Superblocks calls **your own REST or GraphQL API** and you validate the access token in middleware you control.

For Superblocks integration settings, see [Configure Superblocks — REST or GraphQL API integration](../README.md#rest-or-graphql-api-integration) in the main README.

The token exchange handler returns the user's **Entra access token** after validation. Your API receives that same token on each request from Superblocks.

---

## Request flow

```
Superblocks data plane
        │
        ▼
POST /oauth2/token  (your token exchange handler)
        │
        ▼
Returns access_token (validated Entra JWT)
        │
        ▼
Superblocks calls your API with:
  Authorization: Bearer <access_token>
        │
        ▼
Your auth middleware validates the JWT
```

---

## What to validate

Apply the same checks the token exchange handler uses (see [`lib/token-exchange.js`](../lib/token-exchange.js)):

| Check | Source |
|---|---|
| **Signature** | Verify against Entra JWKS for your tenant |
| **Issuer (`iss`)** | Must match your configured issuer (v1 or v2 — see below) |
| **Audience (`aud`)** | Must match your Application ID URI (e.g. `api://<client-id>`) |
| **Expiry (`exp`)** | Reject expired tokens |
| **Tenant (`tid`)** | Optional: must match your `ENTRA_TENANT_ID` |
| **Scope (`scp`)** | Optional: require scopes your API needs |

### Issuer formats

Entra tokens may use either issuer depending on token version:

| Format | Example |
|---|---|
| v1 | `https://sts.windows.net/<tenant-id>/` |
| v2 | `https://login.microsoftonline.com/<tenant-id>/v2.0` |

Set `ENTRA_ISSUER` on the token exchange handler to match your tokens. Use the same value in your API middleware.

JWKS endpoints (the handler tries v2 first, then v1):

- `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`
- `https://login.microsoftonline.com/<tenant-id>/discovery/keys`

---

## Example middleware (Node.js / Express)

Uses the same [`jose`](https://github.com/panva/jose) library as this repo.

```javascript
import { createRemoteJWKSet, jwtVerify } from "jose";

const TENANT_ID = process.env.ENTRA_TENANT_ID;
const AUDIENCE = process.env.ENTRA_AUDIENCE;
const ISSUER =
  process.env.ENTRA_ISSUER
  || `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

const jwks = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`),
);

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: "missing_token" });
  }

  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: "5s",
    });

    if (payload.tid && payload.tid !== TENANT_ID) {
      return res.status(401).json({ error: "tenant_mismatch" });
    }

    // Optional: require a specific scope
    const scopes = String(payload.scp || "").split(/\s+/);
    if (!scopes.includes("access_as_user")) {
      return res.status(403).json({ error: "insufficient_scope" });
    }

    req.user = {
      id: payload.oid || payload.sub,
      email: payload.email || payload.preferred_username || payload.upn,
      claims: payload,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid_token", message: err.message });
  }
}
```

Wire it into your routes:

```javascript
import express from "express";
import { requireAuth } from "./auth.js";

const app = express();

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
```

---

## User identity claims

Common Entra claims for authorization decisions:

| Claim | Description |
|---|---|
| `oid` | Stable Entra object ID for the user |
| `sub` | Subject identifier |
| `email` | Email address (when present) |
| `upn` | User principal name |
| `preferred_username` | Often same as email/UPN |
| `name` | Display name |
| `scp` | Delegated permissions / scopes |

Prefer `oid` as the canonical user ID for lookups in your database.

---

## Environment alignment

Use the **same** Entra settings in your API as on the token exchange handler:

| Variable | Description |
|---|---|
| `ENTRA_TENANT_ID` | Entra tenant GUID |
| `ENTRA_AUDIENCE` | Expected `aud` (Application ID URI) |
| `ENTRA_ISSUER` | Expected `iss` (optional; defaults to v2 issuer) |

If the handler and API disagree on issuer or audience, the handler may accept a token your API rejects (or vice versa).

---

## Testing locally

1. Start the token exchange handler (`npm run func:start` or `npm run sam:local`)
2. Exchange a token manually:

```bash
curl -s -X POST http://localhost:7071/api/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_token=<entra-access-token>" \
  | jq -r .access_token
```

3. Call your API with the returned token:

```bash
curl http://localhost:8080/api/me \
  -H "Authorization: Bearer <access_token>"
```

---

## Production notes

- **Do not** trust tokens without signature verification
- Cache JWKS keys with a reasonable TTL; `jose`'s `createRemoteJWKSet` handles key rotation
- Log validation failures without logging full tokens
- Use HTTPS everywhere between Superblocks, your handler, and your API
- Consider rate limiting and token replay protection for sensitive operations

---

## References

- [Microsoft: Validate access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-tokens)
- [Main README — Entra OAuth resource setup](../README.md#prerequisites-configure-entra-for-your-oauth-resource)
- [Token exchange handler source](../lib/token-exchange.js)
