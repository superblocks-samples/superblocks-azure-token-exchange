# Snowflake setup

Use this guide when Superblocks connects to **Snowflake** using the access token returned by the token exchange handler.

This sample **does not mint Snowflake JWTs**. The handler validates the user's Entra access token and returns it unchanged. Snowflake must trust that token via an **Azure** external OAuth security integration (`EXTERNAL_OAUTH_TYPE = AZURE`).

For a flow that mints custom Snowflake JWTs (Google Workspace → Snowflake), see the separate [superblocks-google-workspace-snowflake-token-exchange](https://github.com/superblocksteam/superblocks-samples/tree/main/superblocks-google-workspace-snowflake-token-exchange) sample.

---

## Overview

```
Superblocks login (Entra)
        │
        ▼
Token exchange handler validates token → returns same Entra access_token
        │
        ▼
Superblocks Snowflake integration sends token to Snowflake (OAuth)
        │
        ▼
Snowflake validates token against external_oauth security integration
```

Snowflake checks the token's `iss`, `aud`, signature (JWKS), OAuth scope (`scp`), and maps the user claim to a Snowflake user.

---

## Prerequisites

- Snowflake account with `ACCOUNTADMIN` (or equivalent) to create a security integration
- Entra OAuth resource configured per the [main README](../README.md#prerequisites-configure-entra-for-your-oauth-resource), with Snowflake OAuth scopes exposed on the app registration
- A Snowflake user for each Entra user who will connect (or provisioning via SCIM)

Follow [Snowflake: Configure Microsoft Entra ID for External OAuth](https://docs.snowflake.com/en/user-guide/oauth-azure) for the full Entra-side procedure (OAuth resource app, scopes, client permissions). The steps below focus on what you need after Entra is configured.

Collect these values from a decoded Entra access token ([jwt.ms](https://jwt.ms)):

| Token claim | Used for |
|---|---|
| `iss` | `EXTERNAL_OAUTH_ISSUER` — must match **exactly** (including trailing slash) |
| `aud` | `EXTERNAL_OAUTH_AUDIENCE_LIST` |
| `tid` | Entra tenant ID (JWKS URL) |
| `email` or `upn` | User mapping claim |
| `scp` | Snowflake role scope (`session:role-any` or `session:role:<ROLE>`) |

**Issuer note:** Entra v1 tokens often use `https://sts.windows.net/<tenant-id>/` (note the trailing slash). v2 tokens use `https://login.microsoftonline.com/<tenant-id>/v2.0`. Set `EXTERNAL_OAUTH_ISSUER` to whatever appears in your token's `iss` claim.

---

## Step 1: Expose Snowflake OAuth scopes in Entra

Snowflake requires an OAuth scope in the token. Without it, login fails even when the token is otherwise valid.

If you have not yet configured the Entra OAuth resource, start with the [README prerequisites](../README.md#prerequisites-configure-entra-for-your-oauth-resource) and [Snowflake's Entra guide](https://docs.snowflake.com/en/user-guide/oauth-azure#configure-the-oauth-resource-in-microsoft-idp).

On your OAuth resource app registration, under **Expose an API** → **Add a scope**, add scopes for the Snowflake role(s) users should assume. For the user-delegated flow Superblocks uses, Snowflake documents scopes with the `session:scope:` prefix:

| Scope name (Entra) | Appears in token `scp` as | When to use |
|---|---|---|
| `session:scope:role-any` or `session:role-any` | `session:role-any` | Use each user's Snowflake `DEFAULT_ROLE` |
| `session:scope:public` | `session:role:public` | Connect as `PUBLIC` |
| `session:scope:<role>` | `session:role:<role>` | Connect as a specific role |

Also expose `session:role:<ROLE>` directly if your Entra setup uses that format (both patterns appear in Snowflake deployments).

Grant admin consent and provide the fully qualified scope(s) to Superblocks, e.g.:

```
api://<client-id>/session:role-any
```

After login, decode the token and confirm `scp` includes a valid Snowflake role scope. Remove invalid scopes (e.g. `session:scope-any`) from the Entra app — they can cause login failures.

See [Using ANY role with External OAuth](https://docs.snowflake.com/en/user-guide/oauth-azure#using-any-role-with-external-oauth) when using `session:role-any`.

---

## Step 2: Create the security integration

Run as `ACCOUNTADMIN`. Replace placeholders with values from your token.

```sql
CREATE OR REPLACE SECURITY INTEGRATION external_oauth_superblocks_entra
  TYPE = EXTERNAL_OAUTH
  ENABLED = TRUE
  EXTERNAL_OAUTH_TYPE = AZURE
  EXTERNAL_OAUTH_ISSUER = 'https://sts.windows.net/<TENANT_ID>/'
  EXTERNAL_OAUTH_JWS_KEYS_URL = 'https://login.microsoftonline.com/<TENANT_ID>/discovery/v2.0/keys'
  EXTERNAL_OAUTH_AUDIENCE_LIST = ('api://<YOUR_APP_CLIENT_ID>')
  EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = 'email'
  EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'LOGIN_NAME'
  EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';
```

| Parameter | Notes |
|---|---|
| `EXTERNAL_OAUTH_ISSUER` | Must match token `iss` exactly |
| `EXTERNAL_OAUTH_AUDIENCE_LIST` | Must include token `aud` (your Application ID URI) |
| `EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM` | `email` or `upn` — whichever your token carries |
| `EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE` | Use **`LOGIN_NAME`**, not `EMAIL_ADDRESS`. Entra `email` is often lowercase while Snowflake `LOGIN_NAME` is uppercase; `EMAIL_ADDRESS` mapping can pass `SYSTEM$VERIFY_EXTERNAL_OAUTH_TOKEN` but still fail login with error 390100 |
| `EXTERNAL_OAUTH_ANY_ROLE_MODE` | Required when using `session:role-any` in the token |

Verify:

```sql
DESC SECURITY INTEGRATION external_oauth_superblocks_entra;
```

---

## Step 3: Snowflake users, roles, and grants

Create or confirm a Snowflake user for each Entra user. The token claim must resolve to an existing user's `LOGIN_NAME`.

```sql
-- Find existing user
SELECT NAME, LOGIN_NAME, EMAIL, DEFAULT_ROLE, DEFAULT_WAREHOUSE
FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
WHERE EMAIL ILIKE 'user@example.com'
   OR LOGIN_NAME ILIKE 'user@example.com';

-- Example: create user (adjust role/warehouse)
CREATE USER IF NOT EXISTS "USER@EXAMPLE.COM"
  EMAIL = 'user@example.com'
  LOGIN_NAME = 'USER@EXAMPLE.COM'
  DEFAULT_ROLE = PUBLIC
  DEFAULT_WAREHOUSE = COMPUTE_WH;

GRANT ROLE PUBLIC TO USER "USER@EXAMPLE.COM";
GRANT USAGE ON INTEGRATION external_oauth_superblocks_entra TO ROLE PUBLIC;
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE PUBLIC;
```

When the token uses `session:role-any`, Snowflake uses the user's **`DEFAULT_ROLE`**. Ensure it is set and granted.

---

## Step 4: Configure Superblocks Snowflake integration

See [Configure Superblocks — Snowflake integration](../README.md#snowflake-integration) in the main README.

Before testing, complete the Snowflake security integration steps above. Superblocks exchanges the user's Entra token through your handler, then passes the returned access token to Snowflake.

---

## Step 5: Validate with the integration test

This repo includes an end-to-end test that exchanges a `subject_token` and connects to Snowflake.

### Setup

```bash
cp env.integration.json.example env.integration.json
# edit SNOWFLAKE_ACCOUNT, SNOWFLAKE_WAREHOUSE, etc.
```

`env.integration.json` example:

```json
{
  "TOKEN_EXCHANGE_URL": "http://localhost:7071/api/oauth2/token",
  "SNOWFLAKE_ACCOUNT": "xy12345.us-east-1",
  "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
  "SNOWFLAKE_ROLE": "",
  "SNOWFLAKE_USERNAME": ""
}
```

### Run

Terminal 1 — start the token exchange handler:

```bash
npm run func:start
# or: npm run sam:local
```

Terminal 2 — run the test with an Entra access token (same token Superblocks would send as `subject_token`):

```bash
SUBJECT_TOKEN=<entra-access-token> npm run test:snowflake
```

In-process exchange (no running server — uses `env.local.json`):

```bash
SUBJECT_TOKEN=<token> npm run test:snowflake -- --direct
```

### Options

| Input | Description |
|---|---|
| `SUBJECT_TOKEN` | Entra access token |
| `SNOWFLAKE_ACCOUNT` | Account identifier (Admin → Accounts) |
| `TOKEN_EXCHANGE_URL` | Handler URL (default `http://localhost:7071/api/oauth2/token`) |
| `SNOWFLAKE_WAREHOUSE` | Warehouse for the test query |
| `SNOWFLAKE_ROLE` | Optional role if not in token scope |
| `SNOWFLAKE_USERNAME` | Optional; defaults to uppercase `email` from token |
| `--direct` | Invoke handler in-process |

On success, the script prints `CURRENT_USER()`, `CURRENT_ROLE()`, and `CURRENT_WAREHOUSE()`.

### Manual test with snowsql

```bash
snowsql -a <account> \
  -u <LOGIN_NAME> \
  --authenticator oauth \
  --token "<access_token>" \
  -w <warehouse> \
  -q "SELECT CURRENT_USER(), CURRENT_ROLE();"
```

Use a **fresh** token (Entra tokens expire in ~90 minutes).

---

## Troubleshooting

### Verify the token in Snowflake

```sql
SELECT SYSTEM$VERIFY_EXTERNAL_OAUTH_TOKEN('<access_token>');
```

Look for `"Validation Result":"Passed"` and a `"User"` field matching the Snowflake user's `LOGIN_NAME`.

VERIFY validates signature, issuer, and audience. Login also requires valid OAuth scope, user mapping, and role/warehouse grants.

### Common issues

| Symptom | Likely cause |
|---|---|
| VERIFY passes, login fails (390100) | `EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'EMAIL_ADDRESS'` — switch to `LOGIN_NAME` |
| `EXTERNAL_OAUTH_ACCESS_TOKEN_ISSUER_NOT_FOUND` | `EXTERNAL_OAUTH_ISSUER` does not match token `iss` exactly |
| Invalid OAuth access token | Wrong `aud`, expired token, or invalid scope in `scp` |
| User not found | No Snowflake user whose `LOGIN_NAME` matches the token claim |
| Role/warehouse errors | Missing `DEFAULT_ROLE`, grants, or `EXTERNAL_OAUTH_ANY_ROLE_MODE` for `session:role-any` |

### Login history

```sql
SELECT EVENT_TIMESTAMP, USER_NAME, IS_SUCCESS, ERROR_CODE, ERROR_MESSAGE
FROM TABLE(
  INFORMATION_SCHEMA.LOGIN_HISTORY_BY_USER(
    USER_NAME => '<LOGIN_NAME>',
    RESULT_LIMIT => 10
  )
)
ORDER BY EVENT_TIMESTAMP DESC;
```

If the error message includes a UUID:

```sql
SELECT SYSTEM$GET_LOGIN_FAILURE_DETAILS('<uuid>');
```

---

## References

- [Snowflake: Configure Microsoft Entra ID for External OAuth](https://docs.snowflake.com/en/user-guide/oauth-azure)
- [Snowflake: External OAuth overview](https://docs.snowflake.com/en/user-guide/oauth-ext-overview)
- [Main README — Entra OAuth resource setup](../README.md#prerequisites-configure-entra-for-your-oauth-resource)
