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

Install Core Tools if `func` is not on your PATH (macOS):

```bash
brew tap azure/functions
brew install azure-functions-core-tools@4
```

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

> **Use Flex Consumption (recommended).** Legacy **Linux Consumption** (`--consumption-plan-location`) is unreliable with `func publish`: the upload succeeds but **Syncing triggers** fails and the host stays at 503. Even Microsoft's default v4 template hits this on many subscriptions. Flex Consumption is the supported serverless Linux plan going forward ([docs](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan)).

```bash
RESOURCE_GROUP=superblocks-token-exchange-rg
LOCATION=eastus
STORAGE_ACCOUNT=sbstokenex$(openssl rand -hex 4)
FUNCTION_APP=superblocks-token-exchange

# Required on new subscriptions — without this, storage create fails with
# misleading "SubscriptionNotFound" even though az group create works.
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.App   # Flex Consumption

az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS

# Flex Consumption (recommended)
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

<details>
<summary>Legacy Linux Consumption (not recommended)</summary>

Only use this if you cannot use Flex Consumption. Expect `func publish` to fail at **Syncing triggers**; see [Troubleshooting](#troubleshooting) for workarounds that may not recover a broken host.

```bash
az functionapp create \
  --resource-group "$RESOURCE_GROUP" \
  --consumption-plan-location "$LOCATION" \
  --runtime node \
  --runtime-version 24 \
  --functions-version 4 \
  --name "$FUNCTION_APP" \
  --storage-account "$STORAGE_ACCOUNT" \
  --os-type Linux
```

</details>

## Deploy code

From the repo root. Use **production dependencies only** so the package stays small (~few MB, not 30+ MB with `snowflake-sdk`):

```bash
npm ci --omit=dev
func azure functionapp publish "$FUNCTION_APP"
npm install   # restore devDependencies for local test:snowflake
```

On **Flex Consumption**, publish should finish with `The deployment was successful!` and list your HTTP triggers. Verify:

```bash
curl "https://$FUNCTION_APP.azurewebsites.net/api/health"
# => ok
```

### Legacy Linux Consumption publish

If you are stuck on Linux Consumption, use the helper script instead of raw `func publish` alone. Core Tools sets `WEBSITE_MOUNT_ENABLED=1`, which conflicts with `WEBSITE_RUN_FROM_PACKAGE` and leaves the host at 503:

```bash
FUNCTION_APP="$FUNCTION_APP" RESOURCE_GROUP="$RESOURCE_GROUP" npm run func:publish:azure
```

If sync triggers still fails after that, **create a new Flex Consumption app** (above) and publish there — that is the reliable fix.

If you already ran `npm install` with devDependencies, the publish still works but uploads a larger package. `--omit=dev` is recommended.

### Upgrade an existing Function App to Node 24

If the app was created with an older Node runtime:

```bash
az functionapp config set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP" \
  --linux-fx-version "NODE|24-lts"
```

Then republish with `func azure functionapp publish`.

## Token URL in Superblocks

After deploy, your endpoint is:

`https://<FUNCTION_APP>.azurewebsites.net/api/oauth2/token`

Use that as the **Token URL** in your Superblocks OAuth 2.0 On-Behalf-Of integration.

> Azure adds the `/api` prefix by default for HTTP triggers. The route in code is `oauth2/token`.

## CORS in production

This handler sets CORS response headers. If you need additional Azure-level CORS rules, configure them on the Function App under **CORS** in the Azure portal.

## Troubleshooting

**`command not found: az`**: Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli). On macOS: `brew install azure-cli`, then `az login`. The `az` commands are only needed for the one-time resource creation step; `func azure functionapp publish` does not require `az` if the Function App already exists.

**`SubscriptionNotFound` on `az storage account create` (but `az group create` works)**: Azure returns this misleading error when the **Microsoft.Storage** resource provider is not registered on your subscription. Fix:

```bash
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.Web   # needed for Function App

# Wait until Registered (can take 1–2 minutes)
az provider show --namespace Microsoft.Storage --query registrationState -o tsv
```

Then retry `az storage account create`. Also re-export `STORAGE_ACCOUNT`, `RESOURCE_GROUP`, and `LOCATION` if you opened a new shell after `az login`.

If you have **two subscriptions with the same name**, pick the correct one explicitly:

```bash
az account list -o table
az account set --subscription "<subscription-id-or-name>"
```

**`Cannot find module` on publish**: Run `npm install` at the repo root before `func azure functionapp publish`.

**401 / signature errors**: Confirm Entra tokens use your API audience, not Microsoft Graph — see the main [README](../README.md#prerequisites-configure-your-entra-app).

**404 on `/oauth2/token`**: Use `/api/oauth2/token` (include the `api` prefix) unless you change the Functions route prefix.

**`Error calling sync triggers (BadRequest)`** after upload succeeds: This is common on **legacy Linux Consumption**. The package upload often succeeds; sync fails because the host runtime is unhealthy (503).

1. **Best fix:** Create a **Flex Consumption** app (see [Create Azure resources](#create-azure-resources-first-time)) and publish there. Verified working with this repo.
2. **If you must stay on Linux Consumption:** After publish, remove the setting Core Tools adds:
   ```bash
   az functionapp config appsettings delete \
     --resource-group "$RESOURCE_GROUP" \
     --name "$FUNCTION_APP" \
     --setting-names WEBSITE_MOUNT_ENABLED
   az functionapp restart --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP"
   ```
   Or run `npm run func:publish:azure`, which does this automatically.
3. Ensure v4 worker indexing is enabled:
   ```bash
   az functionapp config appsettings set \
     --resource-group "$RESOURCE_GROUP" \
     --name "$FUNCTION_APP" \
     --settings AzureWebJobsFeatureFlags=EnableWorkerIndexing
   ```
4. Confirm `package.json` uses a **single entry point** (`"main": "src/index.js"`), not a glob pattern. Glob `main` values work locally but can fail in zip deploy packages.

If the host is still 503 after these steps, the Linux Consumption app is likely unrecoverable — use Flex Consumption instead. See [Troubleshoot Node.js in Azure Functions](https://learn.microsoft.com/en-us/azure/azure-functions/functions-node-troubleshoot?pivots=nodejs-model-v4).
