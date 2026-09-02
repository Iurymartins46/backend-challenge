#!/usr/bin/env bash

set -euo pipefail

base_url="${BASE_URL:-http://localhost:3000}"
curl_max_time_seconds="${CURL_MAX_TIME_SECONDS:-10}"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/distributed-wagering-smoke.XXXXXX")"
body_file="$temp_dir/response.json"

cleanup() {
  rm -f -- "$body_file"
  rmdir -- "$temp_dir"
}
trap cleanup EXIT

http_status=''
http_body=''

request() {
  local method="$1"
  local path="$2"
  shift 2

  http_status="$(curl --silent --show-error --max-time "$curl_max_time_seconds" \
    --output "$body_file" --write-out '%{http_code}' -X "$method" "$base_url$path" "$@")"
  http_body="$(<"$body_file")"
}

expect_status() {
  local expected="$1"
  if [[ "$http_status" != "$expected" ]]; then
    printf 'Expected HTTP %s, received %s. Body: %s\n' "$expected" "$http_status" "$http_body" >&2
    exit 1
  fi
}

expect_body() {
  local expected="$1"
  if [[ "$http_body" != *"$expected"* ]]; then
    printf 'Expected response to contain %s. Body: %s\n' "$expected" "$http_body" >&2
    exit 1
  fi
}

json_string() {
  local key="$1"
  sed -nE "s/.*\"${key}\":\"([^\"]*)\".*/\1/p" "$body_file" | head -n 1
}

player_id="$(bun -e 'console.log(crypto.randomUUID())')"
missing_wallet_id="$(bun -e 'console.log(crypto.randomUUID())')"
external_transaction_id="smoke-$(date +%s)-$$"
idempotency_key="smoke-key-${external_transaction_id}"

printf '%s\n' 'Checking liveness...'
request GET '/health/live'
expect_status 200

printf '%s\n' 'Checking readiness...'
request GET '/health/ready'
expect_status 200

printf '%s\n' 'Checking Swagger JSON...'
request GET '/docs-json'
expect_status 200
expect_body '"openapi"'

printf '%s\n' 'Creating a wallet...'
request POST '/wallets' \
  -H 'content-type: application/json' \
  --data "{\"playerId\":\"$player_id\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
expect_status 201
expect_body '"amount":"100.00"'
wallet_id="$(json_string id)"
if [[ -z "$wallet_id" ]]; then
  printf '%s\n' 'Wallet response did not contain an id.' >&2
  exit 1
fi

wager_body="{\"providerId\":\"smoke-provider\",\"externalTransactionId\":\"$external_transaction_id\",\"playerId\":\"$player_id\",\"walletId\":\"$wallet_id\",\"roundId\":\"smoke-round\",\"gameId\":\"smoke-game\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

printf '%s\n' 'Processing the first BET...'
request POST '/wagering/transactions' \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $idempotency_key" \
  --data "$wager_body"
expect_status 201
expect_body '"status":"PROCESSED"'
transaction_id="$(json_string transactionId)"
if [[ -z "$transaction_id" ]]; then
  printf '%s\n' 'Wager response did not contain a transactionId.' >&2
  exit 1
fi

printf '%s\n' 'Replaying the same BET...'
request POST '/wagering/transactions' \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $idempotency_key" \
  --data "$wager_body"
expect_status 200
expect_body '"idempotentReplay":true'
expect_body "\"transactionId\":\"$transaction_id\""

printf '%s\n' 'Reading the transaction by internal id...'
request GET "/wagering/transactions/$transaction_id"
expect_status 200
expect_body "\"transactionId\":\"$transaction_id\""

printf '%s\n' 'Reading the transaction by provider external id...'
request GET "/providers/smoke-provider/wagering/transactions/$external_transaction_id"
expect_status 200
expect_body "\"transactionId\":\"$transaction_id\""

printf '%s\n' 'Reading the ledger...'
request GET "/wallets/$wallet_id/ledger?limit=100"
expect_status 200
expect_body "\"transactionId\":\"$transaction_id\""

printf '%s\n' 'Reconciling wallet and ledger...'
request POST "/wallets/$wallet_id/reconciliation"
expect_status 200
expect_body '"consistent":true'
expect_body '"amount":"0.00"'

printf '%s\n' 'Checking a missing wallet...'
request GET "/wallets/$missing_wallet_id"
expect_status 404
expect_body 'error.wallet.not_found'

printf '%s\n' 'Checking metrics...'
request GET '/metrics'
expect_status 200

printf 'Smoke HTTP passed for wallet %s and transaction %s.\n' "$wallet_id" "$transaction_id"
