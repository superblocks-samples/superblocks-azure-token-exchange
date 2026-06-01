# Deploy as AWS Lambda

The token handler runs on **AWS Lambda** behind **API Gateway HTTP API**, deployed with [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/).

## Prerequisites

- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS CLI configured (`aws configure` or SSO)
- Node.js 24.x

## Environment variables

For **local** runs, copy `env.local.json.example` to `env.local.json` (shared with Azure Functions local — see [deploy-azure-function.md](deploy-azure-function.md)). For **deploy**, pass values as SAM template parameters (see `template.yaml`).

| Variable | Required | Description |
|---|---|---|
| `ENTRA_TENANT_ID` | Yes | Your Entra tenant GUID |
| `ENTRA_AUDIENCE` | Yes | Expected `aud` in the incoming token (Application ID URI) |
| `ENTRA_ISSUER` | No | Override expected `iss` |
| `REQUIRED_SCOPE` | No | Scope required in the token exchange request body |
| `CORS_ORIGIN` | No | CORS `Access-Control-Allow-Origin` (default `*`) |

## First deploy

```bash
npm install
sam build
sam deploy --guided
```

When prompted, set:

| Parameter | Example |
|---|---|
| `EntraTenantId` | `00000000-0000-0000-0000-000000000000` |
| `EntraAudience` | `api://<client-id>` |
| `EntraIssuer` | *(optional — leave blank to use v2.0 issuer)* |

SAM prints **`TokenEndpoint`**, for example:

`https://abc123.execute-api.us-east-1.amazonaws.com/oauth2/token`

Use that URL as the **Token URL** in your Superblocks integration.

## Subsequent deploys

```bash
sam build && sam deploy
```

SAM reuses `samconfig.toml` from the first `sam deploy --guided`.

## Local development

Prerequisites: Docker Desktop running with file sharing enabled for this repo directory.

```bash
cp env.local.json.example env.local.json
# edit env.local.json

npm run sam:local
```

Test:

```bash
curl --location --request POST \
  --url "http://localhost:3000/oauth2/token" \
  --header "Accept: application/json" \
  --header "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_token=$ENTRA_ACCESS_TOKEN"
```

## Troubleshooting

**`Mounts denied`**: Docker Desktop → Settings → Resources → File Sharing → add the repo parent directory.

**`Cannot find module 'handler'`**: Docker volume mount is empty — fix file sharing and restart Docker.

**`signature verification failed`**: Token `aud` is likely Microsoft Graph. See the main [README](../README.md#prerequisites-configure-your-entra-app).
