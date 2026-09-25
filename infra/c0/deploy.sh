#!/usr/bin/env bash
# C0 deploy: three phases so image push lands between the two Bicep deployments.
#   1) infra.bicep  — RG-scoped: VNet, workload-profiles env, ACR, MI + acrpull
#   2) az acr build — build + push the pinned stock-opencode image
#   3) app.bicep    — the container app (external ingress, pinned C0 recipe)
# Writes connection material to ./c0.env (gitignored; never committed).
#
# Style note: this script deliberately contains no command substitution — the
# workflow guard cannot statically classify $() inside shell text, so outputs
# are read through temp files (IFS= read -r VAR < file) instead.
set -euo pipefail

LOCATION="${LOCATION:-australiaeast}"
RG="${RG:-workflow-dev-rg}"
SUB="${SUB:-b44e1a7e-e9e1-4c4d-a9d0-028fb4515f51}"

cd "${BASH_SOURCE[0]%/*}"

mkdir -p .deploy-tmp

az account set --subscription "$SUB"
echo "== subscription =="
az account show --query name -o tsv

echo "== [1/4] resource group =="
az group create --name "$RG" --location "$LOCATION" --only-show-errors >/dev/null

echo "== [2/4] infra (vnet, env, acr, identity) =="
az deployment group create \
  --resource-group "$RG" \
  --template-file infra.bicep \
  --parameters location="$LOCATION" \
  --only-show-errors >/dev/null

az deployment group show -g "$RG" -n infra --query properties.outputs.acrName.value -o tsv > .deploy-tmp/acr
az deployment group show -g "$RG" -n infra --query properties.outputs.acrLoginServer.value -o tsv > .deploy-tmp/acr_server
az deployment group show -g "$RG" -n infra --query properties.outputs.environmentId.value -o tsv > .deploy-tmp/env_id
az deployment group show -g "$RG" -n infra --query properties.outputs.identityId.value -o tsv > .deploy-tmp/identity_id
IFS= read -r ACR < .deploy-tmp/acr
IFS= read -r ACR_SERVER < .deploy-tmp/acr_server
IFS= read -r ENV_ID < .deploy-tmp/env_id
IFS= read -r IDENTITY_ID < .deploy-tmp/identity_id
echo "   acr=$ACR env=workflow-dev-env"

echo "== [3/4] image build + push (opencode v2.0.10 pinned) =="
az acr build \
  --registry "$ACR" \
  --image "opencode-plane:c0" \
  --file image/Dockerfile \
  image \
  --only-show-errors | tail -3

echo "== [4/4] container app =="
if [[ -n "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
  PASSWORD="$OPENCODE_SERVER_PASSWORD"
else
  openssl rand -base64 24 > .deploy-tmp/pw
  IFS= read -r PASSWORD < .deploy-tmp/pw
fi

az deployment group create \
  --resource-group "$RG" \
  --template-file app.bicep \
  --parameters \
    location="$LOCATION" \
    environmentId="$ENV_ID" \
    identityId="$IDENTITY_ID" \
    acrLoginServer="$ACR_SERVER" \
    opencodeServerPassword="$PASSWORD" \
    imageTag=c0 \
  --only-show-errors >/dev/null

az containerapp show -g "$RG" -n workflow-dev-cplane \
  --query properties.configuration.ingress.fqdn -o tsv > .deploy-tmp/fqdn
IFS= read -r FQDN < .deploy-tmp/fqdn

umask 077
printf 'C0_BASE_URL=https://%s\n' "$FQDN" > c0.env
printf 'C0_SERVER_PASSWORD=%s\n' "$PASSWORD" >> c0.env
printf 'C0_RESOURCE_GROUP=%s\n' "$RG" >> c0.env
printf 'C0_APP_NAME=workflow-dev-cplane\n' >> c0.env
printf 'C0_ACR=%s\n' "$ACR" >> c0.env
echo "== deployed: https://$FQDN (credentials in ./c0.env) =="
echo "== next: node probe.mjs (see README.md) =="
