#!/usr/bin/env bash
# Smoke test helper. Uses file-based signing to avoid shell quoting issues with CJK.
#
# Usage: BASE=... APP_ID=... SECRET=... bash scripts/smoke.sh <biz_type> <biz_id> <content>

set -u

: "${BASE:?BASE is required}"
: "${APP_ID:?APP_ID is required}"
: "${SECRET:?SECRET is required}"

BIZ="${1:?biz_type}"
BID="${2:?biz_id}"
CONTENT="${3:?content}"
MODE="${MODE:-auto}"

TMP=/c/code/ai/.tmp
mkdir -p "$TMP"
BODYF="$TMP/body.bin"
SIGF="$TMP/sig.txt"
BODY_WIN='C:/code/ai/.tmp/body.bin'
SIG_WIN='C:/code/ai/.tmp/sig.txt'

node -e '
const fs = require("node:fs");
const body = JSON.stringify({biz_type: process.argv[1], biz_id: process.argv[2], content: process.argv[3], mode: process.argv[4]});
fs.writeFileSync(process.argv[5], body);
' "$BIZ" "$BID" "$CONTENT" "$MODE" "$BODY_WIN"

node -e '
const fs = require("node:fs");
const { randomBytes, createHash, createHmac } = require("node:crypto");
const body = fs.readFileSync(process.argv[1]);
const secret = process.argv[2];
const ts = Math.floor(Date.now()/1000).toString();
const nonce = randomBytes(16).toString("hex");
const bodyHash = createHash("sha256").update(body).digest("hex");
const sig = createHmac("sha256", secret).update(`${ts}\n${nonce}\n${bodyHash}`).digest("hex");
fs.writeFileSync(process.argv[3], `${ts} ${nonce} ${sig}`);
' "$BODY_WIN" "$SECRET" "$SIG_WIN"

TS=$(awk '{print $1}' "$SIGF")
NONCE=$(awk '{print $2}' "$SIGF")
SIG=$(awk '{print $3}' "$SIGF")

T0=$(date +%s%3N)
RESP=$(curl -sS -w "\n__HTTP__%{http_code}" -X POST "$BASE/v1/moderate" \
  -H "x-app-id: $APP_ID" \
  -H "x-timestamp: $TS" \
  -H "x-nonce: $NONCE" \
  -H "x-signature: $SIG" \
  -H "content-type: application/json" \
  --data-binary "@$BODYF")
T1=$(date +%s%3N)

HTTP="${RESP##*__HTTP__}"
BODY="${RESP%__HTTP__*}"
printf "[%-5dms HTTP %s] %s\n" "$((T1-T0))" "$HTTP" "$BODY"
