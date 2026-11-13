# Deploy as AWS Lambda

The token handler runs on **AWS Lambda** behind an **API Gateway REST API** (regional), deployed with [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/).

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
| `EntraAudience` | `api://<client-id>` for v1 tokens, or the bare `<client-id>` GUID for v2 tokens. Must match the token's `aud` exactly. |
| `EntraIssuer` | *(optional — leave blank to use v2.0 issuer)* |
| `AllowedSourceCidrs` | `0.0.0.0/0` (default, allow all) or your Superblocks egress IPs, e.g. `203.0.113.10/32,203.0.113.11/32`. See [Restrict to Superblocks egress IPs](#restrict-to-superblocks-egress-ips). |
| `ThrottlingRateLimit` | `50` (default, requests per second) |
| `ThrottlingBurstLimit` | `100` (default) |

SAM prints **`TokenEndpoint`**, for example:

`https://abc123.execute-api.us-east-1.amazonaws.com/Prod/oauth2/token`

Use that URL as the **Token URL** in your Superblocks integration. It includes the `/Prod` stage segment.

## Restrict to Superblocks egress IPs

The endpoint is public. To accept requests only from Superblocks, set `AllowedSourceCidrs` to the outbound NAT IPs of the Superblocks data plane that calls the token endpoint. Contact Superblocks for the list. For cloud-prem deployments, include every NAT gateway Elastic IP (one per availability zone) of every Superblocks VPC that runs the agent.

The template attaches an API Gateway resource policy that allows `execute-api:Invoke` and denies it when `aws:SourceIp` is not in `AllowedSourceCidrs`. Requests from other IPs get `403 Forbidden` from API Gateway before the Lambda runs.

To update the list later:

```bash
sam deploy --parameter-overrides AllowedSourceCidrs=203.0.113.10/32,203.0.113.11/32,203.0.113.12/32
```

`sam deploy --parameter-overrides` replaces all overridden parameters, so include the Entra parameters too if they are not saved in `samconfig.toml`. Changing the list creates a new API deployment, so the policy takes effect on deploy.

Verify from a machine whose IP is **not** in the list:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "<TokenEndpoint>"
# 403
```

Then run a Superblocks query that uses the integration. A 403 there means the agent calls from an IP that is missing from the list.

The stage also applies `ThrottlingRateLimit` and `ThrottlingBurstLimit` to all methods.

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

**`403 Forbidden` with `User: anonymous is not authorized to perform: execute-api:Invoke`**: The caller's IP is not in `AllowedSourceCidrs`.

**`403` or `404` on `/oauth2/token`**: Include the `/Prod` stage segment in the URL.

**`signature verification failed`**: Token `aud` is likely Microsoft Graph. See the main [README](../README.md#prerequisites-configure-your-entra-app).
