# GPT Actions Prototype – Bearer Authorised API

This CDK app provisions a bearer-protected HTTP API for Custom GPT Actions experiments. A Python Lambda authoriser validates an `Authorization: Bearer <token>` header against AWS Secrets Manager, and a second Lambda returns a simple JSON payload.

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

The root project’s entry point (`bin/gptapitest.ts`) also reuses this stack but gives it the logical name `GptapitestStack` so that the GitHub Actions workflow can manage it. If you deploy locally via this package, CloudFormation will record the stack as `ProtoBearerStack`.

## Seed the bearer secret

```bash
aws secretsmanager put-secret-value \
  --secret-id gpt/prototype/token \
  --secret-string "$(openssl rand -hex 24)"
```

You may rotate the secret at any time with the same command; older tokens are invalidated immediately because the authoriser reads the secret value on first invocation of a fresh execution environment.

## Smoke test

```bash
bash scripts/smoke.sh
```

The script fetches the stack outputs, retrieves the bearer token from Secrets Manager, and issues unauthorised and authorised requests to verify the API behaviour.

## Wire into a Custom GPT

1. In GPT Builder, choose **Actions** → **Add Action** → **Import from file**, and select `openapi.yaml`.
2. Replace `servers[0].url` with the `ApiBaseUrl` stack output (for example, `https://abc123.execute-api.ap-southeast-2.amazonaws.com`).
3. Configure authentication as a Bearer token and paste the current secret from Secrets Manager.
4. Save the Action, then prompt your GPT with “Call ping”. You should receive a `200` response containing `{ "ok": true, ... }`.

## Clean-up

To remove the resources when you are finished:

```bash
npx cdk destroy ProtoBearerStack
```

The secret is retained by default; delete it manually if you no longer need the credential.
