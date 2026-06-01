# superblocks-azure-token-exchange

Token exchange endpoint for [Superblocks](https://www.superblocks.com/).

This handler serves as the **Token URL** for Superblocks integrations using **OAuth 2.0 On-Behalf-Of Token Exchange** — including **Snowflake**, **REST API**, and **GraphQL** integrations. It receives a user's Entra ID access token, validates it, and returns an access token for your downstream consumer.

Deploy the same logic as either:

| Runtime | Guide |
|---|---|
| **AWS Lambda** (API Gateway HTTP API) | [docs/deploy-lambda.md](docs/deploy-lambda.md) |
| **Azure Function** (HTTP trigger) | [docs/deploy-azure-function.md](docs/deploy-azure-function.md) |

## How it works

```
1. User logs into Superblocks via Entra ID
        │
        ▼
2. User executes a backend API call in a Superblocks app
        │
        ▼
3. The Superblocks data plane calls POST /oauth2/token
   with the user's Entra access token as `subject_token`
        │
        ▼
4. This handler validates the token (signature, issuer, audience, tenant)
        │
        ▼
5. Returns the validated access token to Superblocks
        │
        ▼
6. Superblocks sends the token to a downstream consumer
   (Snowflake, your internal API, etc.)
```

The token returned can be:

- **The original Entra access token** (if it was already minted for your backend API's audience)
- **A different access token** (if you modify the shared handler to mint/exchange for your own tokens)

This current implementation returns the original `subject_token` after validation.

---

## Prerequisites: Configure Entra for your OAuth resource

The token exchange handler validates Entra access tokens and returns them to Superblocks. Those tokens must be minted for **your OAuth resource** — an Entra app registration whose Application ID URI and scopes match what your downstream consumer expects.

**Not Microsoft Graph.** If tokens have `aud: 00000003-0000-0000-c000-000000000000`, they are Graph tokens. This handler cannot validate them, and Snowflake external OAuth will reject them. Configure Entra to issue tokens for your own API instead.

### Choose your setup

| Downstream consumer | Typical Entra app | Scope examples | Setup guide |
|---|---|---|---|
| **Snowflake** | Dedicated [OAuth resource](https://docs.snowflake.com/en/user-guide/oauth-azure#configure-the-oauth-resource-in-microsoft-idp) (or shared SSO app) | `session:role-any`, `session:role:public`, `session:role:analyst`, etc | [docs/setup-snowflake.md](docs/setup-snowflake.md) |
| **Internal API** | App registration exposing your API | `access_as_user`, custom scopes | [docs/setup-internal-api.md](docs/setup-internal-api.md) |

You can use **one app registration** (Superblocks SSO + exposed API scopes) or **separate apps** (SSO client + dedicated OAuth resource). Snowflake's docs describe a dedicated *Snowflake OAuth Resource* app; that same pattern works for any protected resource.

The resource app's **Application ID URI** becomes:

- The token `aud` claim
- The handler's `ENTRA_AUDIENCE` setting
- Snowflake's `EXTERNAL_OAUTH_AUDIENCE_LIST` (when connecting to Snowflake)

### Step 1: Expose an API on your Entra app registration

Follow Microsoft's guide: [Expose scopes in a protected web API](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-protected-web-api-expose-scopes#expose-delegated-permissions-scopes)

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), go to **App registrations**
2. Select your OAuth resource app (the app Superblocks SSO uses, or a dedicated resource app per the [Snowflake Entra guide](https://docs.snowflake.com/en/user-guide/oauth-azure))
3. Under **Expose an API**, set an **Application ID URI** (e.g. `api://<client-id>`)
4. Click **Add a scope** for each permission your downstream consumer requires:

**Snowflake** (user-delegated / on-behalf-of flow):

| Scope name | Purpose |
|---|---|
| `session:role-any` | Use each user's Snowflake `DEFAULT_ROLE` |
| `session:role:<ROLE>` | Connect as a specific role (e.g. `session:role:PUBLIC`) |
| `session:scope:<role>` | Alternative format per [Snowflake docs](https://docs.snowflake.com/en/user-guide/oauth-azure#configure-the-oauth-resource-in-microsoft-idp) |

**Internal API or other resource:**

| Scope name | Purpose |
|---|---|
| `access_as_user` | Common delegated scope for a custom API |
| `<your-scope>` | Any scope name your API middleware checks |

See the [consumer setup guides](#downstream-consumers) for scope and validation details specific to each target.

### Step 2: Grant scopes to the Superblocks client

If the Superblocks SSO app and the OAuth resource are **different** app registrations:

1. Open the **Superblocks SSO app** → **API permissions**
2. Click **Add a permission** → **My APIs** → select your OAuth resource app
3. Check the delegated scopes your downstream consumer needs → **Add permissions**
4. Grant admin consent if required

If you use a **single app** for SSO and the resource, ensure the scopes from Step 1 are exposed on that app.

### Step 3: Configure the token exchange handler

Set environment variables to match the token Entra issues:

| Variable | Value |
|---|---|
| `ENTRA_TENANT_ID` | Your Entra tenant GUID |
| `ENTRA_AUDIENCE` | Application ID URI of the OAuth resource (token `aud`) |
| `ENTRA_ISSUER` | *(optional)* Token `iss` — set if not using the v2 default. v1 tokens often use `https://sts.windows.net/<tenant-id>/` |

### Step 4: Provide scopes to Superblocks

Superblocks must request the resource scopes at login. Provide the fully qualified scope(s) to your Superblocks team:

```
api://<RESOURCE_CLIENT_ID>/<scope-name>
```

Examples:

```
api://<client-id>/session:role-any          # Snowflake
api://<client-id>/access_as_user            # Internal API
```

Request every scope your downstream consumer needs. The token Superblocks receives should include those values in `scp`.

### Avoid extra consent prompts at login

Users see a second permission screen when Superblocks requests scopes that are not already consented for the tenant or pre-authorized for the Superblocks client app. To avoid that:

**1. Grant tenant-wide admin consent (required for most enterprises)**

On the **Superblocks SSO app registration** (the client users sign in with):

1. Go to **API permissions**
2. Ensure every delegated scope is listed (your API app’s `access_as_user`, Snowflake `session:role-any`, etc.)
3. Click **Grant admin consent for [your organization]**
4. Confirm the **Status** column shows a green check for each permission

Repeat this whenever you add new scopes. Without admin consent, each user may be prompted the first time they need that scope.

**2. Pre-authorize the Superblocks client on the OAuth resource app (recommended for custom APIs)**

On the app that **exposes** the scopes (your API / Snowflake OAuth resource), not the SSO client:

1. **Expose an API** → **Authorized client applications** → **Add a client application**
2. Enter the **Application (client) ID** of your Superblocks SSO app
3. Select every scope Superblocks will request (`access_as_user`, `session:role-any`, etc.)
4. Save

Pre-authorization tells Entra this client is trusted for those permissions, so users are not asked to consent when Superblocks requests them. See [Microsoft: Application consent experience](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience).

**3. Use one app registration when possible**

If the same app registration handles Superblocks SSO **and** exposes your API scopes, you avoid cross-app permission grants. Snowflake’s docs often use a separate *Snowflake OAuth Resource* app; in that case, use steps 1 and 2 above.

**4. Scope settings when you create them**

When adding a scope under **Expose an API**, set **Who can consent** to **Admins only** if you rely on admin consent (typical for production). Then complete step 1 before users sign in.

**5. Confirm Superblocks is not forcing consent**

Ensure your Superblocks / Entra SSO configuration does not send `prompt=consent` on every login. That parameter forces the consent UI even when permissions are already granted.

**6. Tenant consent policy (optional)**

In **Entra ID** → **Enterprise applications** → **Consent and permissions**, you can restrict user consent so only pre-consented apps are used. Pair that with admin consent and pre-authorization so users never see ad-hoc prompts.

### Step 5: Verify

Decode a token from Superblocks at [jwt.ms](https://jwt.ms):

| Claim | Expected |
|---|---|
| `aud` | Your Application ID URI (not `00000003-0000-0000-c000-000000000000`) |
| `iss` | Your tenant issuer (must match `ENTRA_ISSUER` if set) |
| `scp` | Includes scopes required by your downstream consumer |
| `email` or `upn` | Present when needed (e.g. Snowflake user mapping) |

Then configure the downstream consumer — [Snowflake](docs/setup-snowflake.md) or [internal API](docs/setup-internal-api.md).

---

## Configuring the Superblocks integration

Create the integration type that matches your downstream consumer. The **Token URL** and on-behalf-of token exchange fields are the same; other settings differ.

| | **Snowflake** | **REST / GraphQL API** |
|---|---|---|
| Integration type | **Snowflake** | **REST API** or **GraphQL** |
| Auth type | OAuth2 - On-Behalf-Of Token Exchange | OAuth2 - On-Behalf-Of Token Exchange |
| Entra SSO scopes | Snowflake role scopes (e.g. `api://<client-id>/session:role-any`) | API scopes (e.g. `api://<client-id>/access_as_user`) |
| Token usage | Superblocks passes the token to Snowflake as an OAuth access token | Superblocks sends `Authorization: Bearer <token>` to your API |
| Backend setup | [docs/setup-snowflake.md](docs/setup-snowflake.md) | [docs/setup-internal-api.md](docs/setup-internal-api.md) |

See the [Superblocks OAuth 2.0 docs](https://docs.superblocks.com/integrations/auth/oauth-20#on-behalf-of-token-exchange) for full details.

### Snowflake integration

In Superblocks, create a **Snowflake** integration (not a REST API integration).

| Field | Value |
|---|---|
| **Auth type** | OAuth2 - On-Behalf-Of Token Exchange |
| **Subject token source** | Login Identity Provider |
| **Subject token type** | `urn:ietf:params:oauth:token-type:access_token` |
| **Token URL** | Your deployed token exchange endpoint (see [Token URL examples](#token-url-examples)) |
| **Account** | Snowflake account identifier (e.g. `xy12345.us-east-1`) |
| **Client ID** | *(optional — ignored by this handler)* |
| **Client secret** | *(optional — ignored by this handler)* |

Before testing, configure Snowflake external OAuth to trust the Entra token this handler returns — see [docs/setup-snowflake.md](docs/setup-snowflake.md). The returned token is the **original Entra JWT**, not a Snowflake-specific JWT.

Users must sign in to Superblocks with Entra SSO scopes that include a Snowflake role scope (e.g. `session:role-any`). Superblocks exchanges that token through your handler, then passes it to Snowflake.

### REST or GraphQL API integration

In Superblocks, create a **REST API** or **GraphQL** integration pointing at your backend.

| Field | Value |
|---|---|
| **Auth type** | OAuth2 - On-Behalf-Of Token Exchange |
| **Subject token source** | Login Identity Provider |
| **Subject token type** | `urn:ietf:params:oauth:token-type:access_token` |
| **Token URL** | Your deployed token exchange endpoint (see [Token URL examples](#token-url-examples)) |
| **Base URL** | Your API base URL (e.g. `https://api.example.com`) |
| **Client ID** | *(optional — ignored by this handler)* |
| **Client secret** | *(optional — ignored by this handler)* |
| **Audience** | *(optional)* |
| **Scopes** | *(optional)* |

Users must sign in with Entra SSO scopes your API expects (e.g. `access_as_user`). Superblocks exchanges the token through your handler, then calls your API with `Authorization: Bearer <access_token>`. Validate the token in your middleware — see [docs/setup-internal-api.md](docs/setup-internal-api.md).

### Token URL examples

- **Lambda**: `https://<api-id>.execute-api.<region>.amazonaws.com/oauth2/token`
- **Azure Function**: `https://<app-name>.azurewebsites.net/api/oauth2/token`

### Token exchange request and response

Superblocks POSTs to your Token URL:

```bash
curl --location --request POST \
  --url '{token_url}' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'subject_token={Entra access token from user login}' \
  --data-urlencode 'scope={scopes}' \
  --data-urlencode 'audience={audience}'
```

### Expected response

```json
{
  "access_token": "eyJraWQiOi...",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

---

## Downstream consumers

After token exchange, Superblocks forwards the returned access token to the integration you configured above ([Snowflake](#snowflake-integration) or [REST/GraphQL API](#rest-or-graphql-api-integration)). Configure the backend to trust the same Entra JWT the handler validates.

| Consumer | Guide |
|---|---|
| **Snowflake** (External OAuth) | [docs/setup-snowflake.md](docs/setup-snowflake.md) — security integration, Entra scopes, integration test |
| **Internal API** (your auth middleware) | [docs/setup-internal-api.md](docs/setup-internal-api.md) — JWT validation, Express example, local testing |

### Snowflake

Snowflake accepts the Entra access token directly via an **Azure** external OAuth security integration. You do not mint Snowflake JWTs in this sample.

See [docs/setup-snowflake.md](docs/setup-snowflake.md) for:

- Entra scope configuration (`session:role-any` or `session:role:<ROLE>`)
- Security integration SQL (`EXTERNAL_OAUTH_TYPE = AZURE`)
- User mapping (`LOGIN_NAME` vs `EMAIL_ADDRESS`)
- Running `npm run test:snowflake` end-to-end

### Internal API

If Superblocks calls a REST or GraphQL API you own, validate the `Authorization: Bearer` token in your middleware — same issuer, audience, and JWKS checks as the token exchange handler.

See [docs/setup-internal-api.md](docs/setup-internal-api.md) for validation requirements and an Express middleware example using `jose`.

---

## Environment variables

Same variables for Lambda and Azure Function. For **local** runs, use a single `env.local.json` (see below). In **production**, set them via SAM parameters (Lambda) or Function App application settings (Azure).

| Variable | Required | Description |
|---|---|---|
| `ENTRA_TENANT_ID` | Yes | Your Entra tenant GUID |
| `ENTRA_AUDIENCE` | Yes | Expected `aud` in the incoming token (your Application ID URI, e.g. `api://<client-id>`) |
| `ENTRA_ISSUER` | No | Override expected `iss` (defaults to `https://login.microsoftonline.com/<tenant>/v2.0`) |
| `REQUIRED_SCOPE` | No | If set, the `scope` sent in the `/oauth2/token` request payload must include this value |
| `TOKEN_TTL_SECONDS` | No | Fallback `expires_in` when token has no `exp` (default `3600`) |
| `CORS_ORIGIN` | No | CORS `Access-Control-Allow-Origin` (default `*`) |

---

## Repo structure

```
├── lib/token-exchange.js           Shared token exchange logic
├── src/
│   ├── handler.js                  AWS Lambda entry point
│   ├── index.js                    Azure Functions app entry
│   └── functions/tokenExchange.js  Azure HTTP trigger
├── template.yaml                   AWS SAM (Lambda + HTTP API)
├── host.json                       Azure Functions host config
├── env.local.json.example          Local env for Lambda + Azure (gitignored copy: env.local.json)
├── env.integration.json.example    Snowflake integration test config
├── scripts/sync-local-env.mjs      Writes local.settings.json for `func start`
├── scripts/azure-publish.mjs       Azure deploy (`npm run func:publish:azure`)
├── test/
│   └── snowflake.mjs               Token exchange → Snowflake integration test
├── events/token-exchange.json      Sample event for sam local invoke
├── docs/
│   ├── deploy-lambda.md
│   ├── deploy-azure-function.md
│   ├── setup-snowflake.md
│   └── setup-internal-api.md
└── package.json
```

---

## Local setup

**Prerequisites:** Node.js 24.x (see `.nvmrc` — run `nvm use` if you use nvm).

Shared config for both runtimes:

```bash
npm install
cp env.local.json.example env.local.json
# edit env.local.json — Entra tenant, audience, etc.
```

### AWS Lambda

**Prerequisites:** [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Docker Desktop (with file sharing enabled for this repo).

```bash
npm run sam:local
```

Endpoint: `http://localhost:3000/oauth2/token`

See [docs/deploy-lambda.md](docs/deploy-lambda.md) for curl examples and Docker troubleshooting.

### Azure Function

**Prerequisites:** [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local) v4 (`func` on your PATH), [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) for one-time resource creation.

macOS:

```bash
brew tap azure/functions
brew install azure-functions-core-tools@4
```

```bash
npm run func:start
```

Endpoint: `http://localhost:7071/api/oauth2/token` (Azure adds the `/api` prefix by default).

`func:start` syncs `env.local.json` → `local.settings.json`, then runs `func start`. If `func` is missing, the script prints install instructions. After you change `env.local.json`, run `npm run local:sync-env` again (or restart with `func:start`).

See [docs/deploy-azure-function.md](docs/deploy-azure-function.md) for curl examples and Azure-specific notes.

---

## Deploy

**AWS Lambda** — [docs/deploy-lambda.md](docs/deploy-lambda.md): `sam build && sam deploy --guided`

**Azure Function** — [docs/deploy-azure-function.md](docs/deploy-azure-function.md): create resources, then `FUNCTION_APP=<name> npm run func:publish:azure`

---

## Troubleshooting

**`signature verification failed`**: The token's `aud` is likely set to Microsoft Graph (`00000003-...`). Follow the [Entra OAuth resource configuration](#prerequisites-configure-entra-for-your-oauth-resource) steps above.

**Snowflake OAuth login failures**: See [docs/setup-snowflake.md](docs/setup-snowflake.md#troubleshooting).

For runtime-specific issues (Docker mounts, Azure `/api` prefix, etc.), see the deploy guides linked above.
