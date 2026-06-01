# Deploy as Azure Function

The same token exchange logic runs as an **Azure Functions** HTTP trigger (Node.js 24, programming model v4).

## Prerequisites

- [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local) v4.x
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az login`)
- Node.js 24.x
- An Azure subscription

Install on macOS if commands are missing:

```bash
# Azure CLI (required for "Create Azure resources")
brew install azure-cli

# Functions Core Tools (required for local dev and publish)
brew tap azure/functions
brew install azure-functions-core-tools@4
```

Then sign in:

```bash
az login
az account show   # confirm the correct subscription
```

## Environment variables

For **local** runs, use the same `env.local.json` as AWS SAM (copy from `env.local.json.example`). `npm run func:start` generates `local.settings.json` from it automatically.

In **Azure** (deployed), set the same keys as **Application settings** on the Function App (not `env.local.json`).

| Setting | Required | Description |
|---|---|---|
| `ENTRA_TENANT_ID` | Yes | Your Entra tenant GUID |
| `ENTRA_AUDIENCE` | Yes | Expected `aud` in the incoming token |
| `ENTRA_ISSUER` | No | Override expected `iss` |
| `REQUIRED_SCOPE` | No | Scope required in the request body |
| `CORS_ORIGIN` | No | CORS header (default `*`) |

`AzureWebJobsStorage` is required by the Functions runtime (use a real storage account in production).

## Local development

```bash
npm install
cp env.local.json.example env.local.json
# edit env.local.json

npm run func:start
```

Default URL:

`http://localhost:7071/api/oauth2/token`

Test:

```bash
curl --location --request POST \
  --url "http://localhost:7071/api/oauth2/token" \
  --header "Accept: application/json" \
  --header "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_token=$ENTRA_ACCESS_TOKEN"
```

## Create Azure resources (first time)

Replace placeholders with your values.

```bash
RESOURCE_GROUP=superblocks-token-exchange-rg
LOCATION=eastus
STORAGE_ACCOUNT=sbstokenex$(openssl rand -hex 4)
FUNCTION_APP=superblocks-token-exchange

# Required on new subscriptions — without this, storage create fails with
# misleading "SubscriptionNotFound" even though az group create works.
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.App

az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS

az functionapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP" \
  --storage-account "$STORAGE_ACCOUNT" \
  --flexconsumption-location "$LOCATION" \
  --runtime node \
  --runtime-version 24

az functionapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP" \
  --settings \
    AzureWebJobsFeatureFlags=EnableWorkerIndexing \
    "ENTRA_TENANT_ID=<tenant-guid>" \
    "ENTRA_AUDIENCE=api://<client-id>" \
    "CORS_ORIGIN=*"
```

Optional issuer override:

```bash
az functionapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP" \
  --settings "ENTRA_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0"
```

## Deploy code

From the repo root:

```bash
FUNCTION_APP=superblocks-token-exchange npm run func:publish:azure
```

`npm run func:publish:azure` runs `scripts/azure-publish.mjs`, which:

1. Runs `npm ci --omit=dev` (keeps the package ~few MB, not 30+ MB with `snowflake-sdk`)
2. Runs `func azure functionapp publish`
3. Runs `npm install` to restore devDependencies for local `test:snowflake`
4. Curls `/api/health` and exits non-zero if the check fails

Publish should finish with `The deployment was successful!` and list your HTTP triggers:

```
Functions in superblocks-token-exchange:
    health - [httpTrigger]
        Invoke url: https://superblocks-token-exchange.azurewebsites.net/api/health
    tokenExchange - [httpTrigger]
        Invoke url: https://superblocks-token-exchange.azurewebsites.net/api/oauth2/token
```

Verify:

```bash
curl "https://$FUNCTION_APP.azurewebsites.net/api/health"
# => ok
```

If you already ran `npm install` with devDependencies, publish still works but uploads a larger package. `--omit=dev` is recommended.

## Token URL in Superblocks

After deploy, your endpoint is:

`https://<FUNCTION_APP>.azurewebsites.net/api/oauth2/token`

Use that as the **Token URL** in your Superblocks OAuth 2.0 On-Behalf-Of integration.

> Azure adds the `/api` prefix by default for HTTP triggers. The route in code is `oauth2/token`.

## CORS in production

This handler sets CORS response headers. If you need additional Azure-level CORS rules, configure them on the Function App under **CORS** in the Azure portal.

## Troubleshooting

**`command not found: az`**: Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli). On macOS: `brew install azure-cli`, then `az login`. The `az` commands are only needed for the one-time resource creation step; `npm run func:publish:azure` does not require `az` if the Function App already exists.

**`SubscriptionNotFound` on `az storage account create` (but `az group create` works)**: Azure returns this misleading error when the **Microsoft.Storage** resource provider is not registered on your subscription. Fix:

```bash
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.App

# Wait until Registered (can take 1–2 minutes)
az provider show --namespace Microsoft.Storage --query registrationState -o tsv
```

Then retry `az storage account create`. Also re-export `STORAGE_ACCOUNT`, `RESOURCE_GROUP`, and `LOCATION` if you opened a new shell after `az login`.

If you have **two subscriptions with the same name**, pick the correct one explicitly:

```bash
az account list -o table
az account set --subscription "<subscription-id-or-name>"
```

**`Cannot find module` on publish**: Run `FUNCTION_APP=<name> npm run func:publish:azure` from the repo root (it runs `npm ci --omit=dev` before publishing).

**401 / signature errors**: Confirm Entra tokens use your API audience, not Microsoft Graph — see the main [README](../README.md#prerequisites-configure-your-entra-app).

**404 on `/oauth2/token`**: Use `/api/oauth2/token` (include the `api` prefix) unless you change the Functions route prefix.

**`Error calling sync triggers (BadRequest)` or 503 after publish**: Recreate the function app using the commands in [Create Azure resources](#create-azure-resources-first-time), then run `npm run func:publish:azure` again. Also confirm:

- `AzureWebJobsFeatureFlags=EnableWorkerIndexing` is set
- `package.json` has `"main": "src/index.js"` (single entry point, not a glob pattern)

See [Troubleshoot Node.js in Azure Functions](https://learn.microsoft.com/en-us/azure/azure-functions/functions-node-troubleshoot?pivots=nodejs-model-v4).
