# GPT Actions Prototype – Bearer Authorised API

This CDK app provisions a bearer-protected HTTP API for Custom GPT Actions experiments. A Python Lambda authoriser validates an `Authorization: Bearer <token>` header against AWS Secrets Manager, and a second Lambda returns a JSON payload that echoes an optional `number` attribute sent with the request.

## Prerequisites

- Node.js 18+
- Python 3.12 runtime available in the target AWS region
- AWS CLI v2 configured with credentials that can deploy CloudFormation stacks
- CDK bootstrap run for the target account and region

## Bootstrap (once per account & region)

```bash
npm install -g aws-cdk
cdk bootstrap aws://<account>/<region>
```

## Install, build, and deploy

```bash
npm install
npm run build
npx cdk deploy ProtoBearerStack
```

The root project’s entry point (`bin/opssage.ts`) also reuses this stack but gives it the logical name `OpssageStack` so that the GitHub Actions workflow can manage it. If you deploy locally via this package, CloudFormation will record the stack as `ProtoBearerStack`.

### Optional parameters

- `ProtoBearerStack:ExistingBearerSecretArn` / `ProtoBearerStack:ExistingBearerSecretName`: Provide both values to reuse an existing bearer-token secret instead of creating one.
- `ProtoBearerStack:ExistingOpenAiSecretArn` / `ProtoBearerStack:ExistingOpenAiSecretName`: Provide both values to reuse an existing OpenAI API key secret instead of creating one.
- `ProtoBearerStack:RealtimeTokenBurstLimit` (default `5`): API Gateway burst limit applied to `POST /secure/realtime-token`.  
  - Optional pipeline flag: `--parameters ProtoBearerStack:RealtimeTokenBurstLimit=$REALTIME_TOKEN_BURST`
- `ProtoBearerStack:RealtimeTokenRateLimit` (default `10`): Steady-state rate limit (requests/second) for the token route.  
  - Optional pipeline flag: `--parameters ProtoBearerStack:RealtimeTokenRateLimit=$REALTIME_TOKEN_RATE`
- `ProtoBearerStack:RealtimeModelName` (default `gpt-4o-realtime-preview`): Realtime model requested from OpenAI.  
  - Optional pipeline flag: `--parameters ProtoBearerStack:RealtimeModelName=$REALTIME_MODEL`

Whenever these values change in CI/CD, pass them via `cdk deploy --parameters ...` or configure the pipeline to inject them.

## Seed the bearer secret

```bash
STACK_NAME="${STACK_NAME:-ProtoBearerStack}"
SECRET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SecretName'].OutputValue" \
  --output text)
aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string "$(openssl rand -hex 24)"
```

You may rotate the secret at any time with the same command; older tokens are invalidated immediately because the authoriser reads the secret value on first invocation of a fresh execution environment.

## Populate the OpenAI API key

The stack provisions an empty secret at `/<stack-name>/openai/api-key`. After deployment, populate it with your OpenAI platform key:

```bash
STACK_NAME="${STACK_NAME:-ProtoBearerStack}"
OPENAI_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='OpenAiSecretArn'].OutputValue" \
  --output text)
aws secretsmanager put-secret-value \
  --secret-id "$OPENAI_SECRET_ARN" \
  --secret-string "$OPENAI_API_KEY"
```

If you pass the `ExistingOpenAiSecretArn`/`ExistingOpenAiSecretName` parameters, the stack references the secret you supply instead and skips creating a new one—ensure it already holds the correct API key value.

The Lambda that calls OpenAI reads both the bearer secret and this API key secret at runtime; neither value is exposed to the browser.

### Lambda environment variables

The stack wires the following variables into the realtime token Lambda. They are documented here in case you need to override them in future enhancements:

- `SECRET_NAME`: Secrets Manager name for the bearer token (created by the stack).
- `OPENAI_API_KEY_SECRET_ARN`: ARN of the OpenAI key secret created by the stack.
- `REALTIME_MODEL`: Model name provided by the `RealtimeModelName` parameter.
- `API_BASE_URL`: Derived from the deployed API’s endpoint so the tool spec can reference the live URL.

## Smoke test

```bash
bash scripts/smoke.sh
```

The script fetches the stack outputs, retrieves the bearer token from Secrets Manager, and issues unauthorised and authorised requests to verify the API behaviour. Export `NUMBER=<value>` before running to change the echoed number (defaults to `42`).

## Wire into a Custom GPT

1. In GPT Builder, choose **Actions** → **Add Action** → **Import from file**, and select `openapi.yaml`.
2. Replace `servers[0].url` with the `ApiBaseUrl` stack output (for example, `https://abc123.execute-api.ap-southeast-2.amazonaws.com`).
3. Configure authentication as a Bearer token and paste the current secret from Secrets Manager.
4. Save the Action, then prompt your GPT with “Call ping”. You should receive a `200` response containing `{ "ok": true, ..., "message": "you sent me <number>" }` when the Action supplies the `number` query parameter.

## Mint realtime tokens for the browser

The stack now exposes a second secured route, `POST /secure/realtime-token`, that returns an ephemeral token for OpenAI’s Realtime API. Callers must present the same bearer token used for `/secure/ping`. Optional JSON fields let you pass custom instructions, voice, or `expires_in` seconds for the temporary session:

```bash
curl -X POST \
  -H "Authorization: Bearer ${BEARER}" \
  -H "Content-Type: application/json" \
  "${API_BASE_URL}/secure/realtime-token" \
  -d '{"instructions": "Keep responses short"}'
```

Configure the CORS-aware HTML PoC so it first requests a realtime token from this endpoint and then connects to OpenAI Realtime (WebRTC/WebSocket) using the returned payload. Rate limiting for this route is governed by the `RealtimeTokenBurstLimit` and `RealtimeTokenRateLimit` parameters, making it easy to tune via pipeline or environment overrides.

## Clean-up

To remove the resources when you are finished:

```bash
npx cdk destroy ProtoBearerStack
```

The secret is retained by default; delete it manually if you no longer need the credential.
