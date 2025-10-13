#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-GptapitestStack}"
REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-}}"
NUMBER_VALUE="${NUMBER:-42}"

aws_args=()
if [[ -n "$REGION" ]]; then
  aws_args+=(--region "$REGION")
fi

api_base_url=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" ${aws_args[@]+"${aws_args[@]}"} \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" \
  --output text)

if [[ -z "$api_base_url" || "$api_base_url" == "None" ]]; then
  echo "Failed to resolve ApiBaseUrl output" >&2
  exit 1
fi

secret_name=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" ${aws_args[@]+"${aws_args[@]}"} \
  --query "Stacks[0].Outputs[?OutputKey=='SecretName'].OutputValue" \
  --output text)

if [[ -z "$secret_name" || "$secret_name" == "None" ]]; then
  echo "Failed to resolve SecretName output" >&2
  exit 1
fi

secret_value=$(aws secretsmanager get-secret-value \
  --secret-id "$secret_name" ${aws_args[@]+"${aws_args[@]}"} \
  --query 'SecretString' \
  --output text)

if [[ -z "$secret_value" || "$secret_value" == "None" ]]; then
  echo "Secret has no value. Seed it before running the smoke test." >&2
  exit 1
fi

unauth_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -G \
  --data-urlencode "number=$NUMBER_VALUE" \
  "$api_base_url/secure/ping")
if [[ "$unauth_status" != "401" && "$unauth_status" != "403" ]]; then
  echo "Expected unauthorised request to return 401/403 but received $unauth_status" >&2
  exit 1
fi

tmp_response=$(mktemp)
auth_status=$(curl -s -o "$tmp_response" -w '%{http_code}' \
  -G \
  --data-urlencode "number=$NUMBER_VALUE" \
  -H "Authorization: Bearer $secret_value" \
  "$api_base_url/secure/ping")

if [[ "$auth_status" != "200" ]]; then
  echo "Expected authorised request to return 200 but received $auth_status" >&2
  cat "$tmp_response" >&2
  rm -f "$tmp_response"
  exit 1
fi

if ! grep -q '"ok": true' "$tmp_response"; then
  echo "Authenticated response body did not contain expected payload" >&2
  cat "$tmp_response" >&2
  rm -f "$tmp_response"
  exit 1
fi

if [[ -n "$NUMBER_VALUE" ]]; then
  expected_message="\"message\": \"you sent me ${NUMBER_VALUE}\""
else
  expected_message="\"message\": \"you sent me nothing\""
fi

if ! grep -F "$expected_message" "$tmp_response"; then
  echo "Authenticated response body did not include expected message" >&2
  cat "$tmp_response" >&2
  rm -f "$tmp_response"
  exit 1
fi

cat "$tmp_response"
rm -f "$tmp_response"
echo "\nSmoke test passed"
