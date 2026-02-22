# superblocks-azure-token-exchange

AWS Lambda token exchange endpoint for [Superblocks](https://www.superblocks.com/).

This Lambda serves as the **Token URL** for a Superblocks REST or GraphQL integration using the **OAuth 2.0 On-Behalf-Of Token Exchange** authorization method. It receives a user's Entra ID access token, validates it, and returns an access token your backend API can trust.

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
4. This Lambda validates the token (signature, issuer, audience, tenant)
        │
        ▼
5. Returns the validated access token to Superblocks
        │
        ▼
6. Superblocks sends the token to your backend API
```

The token returned can be:

- **The original Entra access token** (if it was already minted for your backend API's audience)
- **A different access token** (if you modify this Lambda to mint/exchange for your own tokens)

This current implementation returns the original `subject_token` after validation.

---

## Prerequisites: Configure your Entra app

For this flow to work, the Entra app used when logging into Superblocks **must issue access tokens for your backend API** — not for Microsoft Graph.

If your tokens have `aud: 00000003-0000-0000-c000-000000000000`, they are Graph tokens and **cannot be verified by third-party code**. You need to configure your Entra app to expose your own API.

### Step 1: Expose an API on your Entra app registration

Follow Microsoft's guide: [Expose scopes in a protected web API](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-protected-web-api-expose-scopes#expose-delegated-permissions-scopes)

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), go to **App registrations** and select the app you use for **Superblocks SSO**
2. Under **Expose an API**, set an **Application ID URI** (accept the default `api://<client-id>` or set a custom one)
3. Click **Add a scope** with these settings:
   - **Scope name**: `access_as_user`
   - **Who can consent**: Admins and users
   - **Admin consent display name**: Access your API as a user
   - **State**: Enabled

### Step 2: Grant your Superblocks client app access

If the Superblocks SSO app and the API app are different app registrations:

1. Go to the **Superblocks SSO app registration** → **API permissions**
2. Click **Add a permission** → **My APIs** → select your API app
3. Check the `access_as_user` scope → **Add permissions**
4. Grant admin consent if required

### Step 3: Provide your API scope to Superblocks

Superblocks needs to request your API scope when users log in via Entra SSO. Provide the following scope to your Superblocks team so they can add it to your SSO configuration:

```
api://<YOUR_APP_CLIENT_ID>/access_as_user
```

This ensures that when users log into Superblocks, Entra mints access tokens with:
- `aud` = your Application ID URI (e.g. `api://<YOUR_APP_CLIENT_ID>`)
- `scp` = `access_as_user`

### Step 4: Verify

Decode a token from Superblocks at [jwt.ms](https://jwt.ms) and confirm:
- `aud` is your Application ID URI (not `00000003-0000-0000-c000-000000000000`)
- `iss` is your tenant's issuer
- `scp` includes `access_as_user`

---

## Configuring the Superblocks integration

In Superblocks, create a REST API integration with auth type **OAuth2 - On-Behalf-Of Token Exchange**.

| Field | Value |
|---|---|
| **Subject token source** | Login Identity Provider |
| **Subject token type** | `urn:ietf:params:oauth:token-type:access_token` |
| **Token URL** | Your deployed Lambda endpoint (e.g. `https://<api-id>.execute-api.<region>.amazonaws.com/oauth2/token`) |
| **Client ID** | *(optional — ignored by this Lambda)* |
| **Client secret** | *(optional — ignored by this Lambda)* |
| **Audience** | *(optional)* |
| **Scopes** | *(optional)* |

See the [Superblocks OAuth 2.0 docs](https://docs.superblocks.com/integrations/auth/oauth-20#on-behalf-of-token-exchange) for full details.

### Request format

Superblocks sends the following request to your Token URL:

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

## Lambda environment variables

Copy `env.local.json.example` to `env.local.json` and fill in your values.

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
├── src/handler.js              Lambda handler
├── template.yaml               AWS SAM template (HTTP API + Lambda)
├── events/token-exchange.json   Sample event for sam local invoke
├── env.local.json.example       Sample env vars for SAM local
├── package.json
└── package-lock.json
```

---

## Deploy (AWS SAM)

```bash
sam build
sam deploy --guided
```

---

## Local development

Prerequisites:
- Docker Desktop running
- Docker Desktop file sharing enabled for your repo directory

```bash
cp env.local.json.example env.local.json
# edit env.local.json with your Entra tenant/audience values

npm run sam:local
```

Test with curl:

```bash
curl --location --request POST \
  --url "http://127.0.0.1:3000/oauth2/token" \
  --header "Accept: application/json" \
  --header "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_token=$ENTRA_ACCESS_TOKEN"
```

### Troubleshooting

**`Mounts denied` error**: Docker Desktop → Settings → Resources → File Sharing → add your repo parent directory → Apply & Restart.

**`Cannot find module 'handler'`**: Usually means the Docker volume mount is empty. Fix file sharing and restart Docker Desktop.

**`signature verification failed`**: The token's `aud` is likely set to Microsoft Graph (`00000003-...`). Follow the [Entra app configuration](#prerequisites-configure-your-entra-app) steps above to mint tokens for your own API.
