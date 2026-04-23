#!/usr/bin/env bash
# Bootstrap Cloudflare resources for ai-guard and write IDs back to wrangler.toml.
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN (and optionally CLOUDFLARE_ACCOUNT_ID) exported
#   - Token allowed to call the account (no IP restriction, or your IP allowlisted)
#   - Run from the project root
#
# Usage:
#   bash scripts/bootstrap-cf.sh dev       # creates ai-guard-dev-* resources
#   bash scripts/bootstrap-cf.sh prod      # creates ai-guard-* resources
#
# Idempotent: resources that already exist are reused.

set -euo pipefail

ENV_NAME="${1:-dev}"
if [[ "$ENV_NAME" != "dev" && "$ENV_NAME" != "prod" ]]; then
  echo "usage: $0 dev|prod" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is not set. export it first." >&2
  exit 1
fi

[[ -f "wrangler.toml" ]] || { echo "wrangler.toml not found — run from project root" >&2; exit 1; }

if [[ "$ENV_NAME" == "dev" ]]; then
  D1_NAME="ai-guard-dev"
  QUEUES=(ai-guard-dev-moderation ai-guard-dev-callback ai-guard-dev-moderation-dlq ai-guard-dev-callback-dlq)
  KV_PREFIX="ai-guard-dev"
else
  D1_NAME="ai-guard"
  QUEUES=(ai-guard-moderation ai-guard-callback ai-guard-moderation-dlq ai-guard-callback-dlq)
  KV_PREFIX="ai-guard"
fi

TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR/ai-guard-bootstrap"
STATE_DIR="$TMPDIR/ai-guard-bootstrap"

echo ""
echo "==> Creating D1 database '$D1_NAME'"
wrangler d1 list --json > "$STATE_DIR/d1.json"
D1_ID="$(node scripts/lib/find-json.mjs "$STATE_DIR/d1.json" name "$D1_NAME" uuid || true)"
if [[ -z "$D1_ID" ]]; then
  wrangler d1 create "$D1_NAME" > "$STATE_DIR/d1_create.log" 2>&1 || true
  cat "$STATE_DIR/d1_create.log" >&2
  wrangler d1 list --json > "$STATE_DIR/d1.json"
  D1_ID="$(node scripts/lib/find-json.mjs "$STATE_DIR/d1.json" name "$D1_NAME" uuid || true)"
fi
[[ -n "$D1_ID" ]] || { echo "failed to resolve D1 id for $D1_NAME" >&2; exit 1; }
echo "    D1 $D1_NAME: $D1_ID"

echo ""
echo "==> Creating KV namespaces"
declare -A KV_IDS
declare -A KV_LABELS=(
  [DEDUP_CACHE]="dedup-cache"
  [PROMPTS]="prompts"
  [APPS]="apps"
  [NONCE]="nonce"
)
wrangler kv namespace list > "$STATE_DIR/kv.json"
for NS in DEDUP_CACHE PROMPTS APPS NONCE; do
  LABEL="${KV_LABELS[$NS]}"
  FULL="${KV_PREFIX}-${LABEL}"
  ID="$(node scripts/lib/find-json.mjs "$STATE_DIR/kv.json" title "$FULL" id || true)"
  if [[ -z "$ID" ]]; then
    wrangler kv namespace create "$FULL" > "$STATE_DIR/kv_create.log" 2>&1 || true
    cat "$STATE_DIR/kv_create.log"
    wrangler kv namespace list > "$STATE_DIR/kv.json"
    ID="$(node scripts/lib/find-json.mjs "$STATE_DIR/kv.json" title "$FULL" id || true)"
  fi
  [[ -n "$ID" ]] || { echo "failed to resolve KV id for $FULL" >&2; exit 1; }
  KV_IDS[$NS]="$ID"
  echo "    KV $FULL: $ID"
done

echo ""
echo "==> Creating Queues"
for Q in "${QUEUES[@]}"; do
  if wrangler queues info "$Q" > /dev/null 2>&1; then
    echo "    exists: $Q"
  else
    wrangler queues create "$Q" > /dev/null
    echo "    created: $Q"
  fi
done

echo ""
echo "==> Patching wrangler.toml"
node scripts/lib/patch-toml.mjs \
  "$ENV_NAME" \
  "$D1_ID" \
  "${KV_IDS[DEDUP_CACHE]}" \
  "${KV_IDS[PROMPTS]}" \
  "${KV_IDS[APPS]}" \
  "${KV_IDS[NONCE]}"

echo ""
echo "==> Applying D1 migrations"
if [[ "$ENV_NAME" == "dev" ]]; then
  wrangler d1 migrations apply "$D1_NAME" --env dev --remote
else
  wrangler d1 migrations apply "$D1_NAME" --remote
fi

echo ""
echo "==> Bootstrap complete for env=$ENV_NAME"
echo ""
echo "Next steps:"
echo "  1) Put secrets (you'll be prompted to paste each value):"
if [[ "$ENV_NAME" == "dev" ]]; then
  echo "       wrangler secret put GROK_API_KEY    --env dev"
  echo "       wrangler secret put GEMINI_API_KEY  --env dev"
  echo "       wrangler secret put ADMIN_TOKEN     --env dev"
  echo ""
  echo "  2) Deploy:"
  echo "       pnpm deploy:dev"
else
  echo "       wrangler secret put GROK_API_KEY"
  echo "       wrangler secret put GEMINI_API_KEY"
  echo "       wrangler secret put ADMIN_TOKEN"
  echo ""
  echo "  2) Deploy:"
  echo "       pnpm deploy"
fi
