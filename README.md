# GPT Bearer Prototype Infrastructure

This repository contains the AWS CDK application that provisions the bearer-protected HTTP API, its Python Lambda handlers, and supporting AWS resources. Authenticated requests to `/secure/ping` echo an optional `number` attribute, returning `you sent me <number>` when supplied or `you sent me nothing` otherwise. The CDK code is written in TypeScript and the GitHub Actions workflow in `.github/workflows/cdk.yml` handles builds and deployments to the nominated account.

The `cdk.json` file defines how the CDK Toolkit executes the app entry point.

## Useful commands

* `npm run build`   compile TypeScript to JavaScript
* `npm run watch`   watch for changes and compile
* `npm run test`    execute the Jest unit tests
* `npx cdk deploy`  deploy the stack to your default AWS account/region
* `npx cdk diff`    compare the deployed stack with current state
* `npx cdk synth`   emit the synthesised CloudFormation template

## Bootstrapping

The CDK toolkit needs a bootstrap stack in each account/region before this project can deploy. Run this once per environment (replace the region if required):

```bash
npx cdk bootstrap aws://${AWS_ACCOUNT}/${AWS_REGION}
```

You can provide the account/region via environment variables or inline (e.g. `npx cdk bootstrap aws://592230817133/ap-southeast-2`).

## Required configuration

- **OpenAI API key secret**: The stack provisions an empty secret at `/<stack-name>/openai/api-key`. After deployment, update it with your OpenAI platform key: `aws secretsmanager put-secret-value --secret-id <arn> --secret-string "$OPENAI_API_KEY"`.
- **Bearer token secret**: The stack provisions `/<stack-name>/opssage/bearer-token`. Update it with your shared bearer string via `aws secretsmanager put-secret-value`.
- **Rate limits / model overrides** (optional): Override the following parameters if the defaults (5 burst, 10 rps, `gpt-4o-realtime-preview`) need tuning:  
  - `OpssageStack:RealtimeTokenBurstLimit`  
  - `OpssageStack:RealtimeTokenRateLimit`  
  - `OpssageStack:RealtimeModelName`
  Include the same flags in your pipeline command when you change these values.
- **Client configuration**: Front-end callers must supply the bearer secret in the `Authorization` header when requesting `/secure/ping` or `/secure/realtime-token`.

### Populate secrets after deployment

```bash
STACK_NAME="${STACK_NAME:-OpssageStack}"
SECRET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SecretName'].OutputValue" \
  --output text)
OPENAI_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='OpenAiSecretArn'].OutputValue" \
  --output text)

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string '<bearer-token>'

aws secretsmanager put-secret-value \
  --secret-id "$OPENAI_SECRET_ARN" \
  --secret-string "$OPENAI_API_KEY"
```

Repeat the commands whenever you rotate either credential.

### Redeploying after a stack deletion

CDK retains both secrets (`/<stack-name>/opssage/bearer-token` and `/<stack-name>/openai/api-key`) even after the stack is destroyed. If you delete the stack and immediately redeploy without clearing those secrets, CloudFormation still fails resource creation because Secrets Manager keeps the names reserved. CDK cannot purge them automatically, so remove them manually via the CLI before redeploying:

```bash
aws secretsmanager delete-secret \
  --secret-id "OpssageStack/openai/api-key" \
  --force-delete-without-recovery

aws secretsmanager delete-secret \
  --secret-id "OpssageStack/opssage/bearer-token" \
  --force-delete-without-recovery

# Legacy name from the original fork, only needed if it exists in your account.
aws secretsmanager delete-secret \
  --secret-id "GptapitestStack/gptapitest/bearer-token" \
  --force-delete-without-recovery
```

The deletion must be triggered from the command line (or console); CDK does not support forcing removal of retained secrets during redeploys.

### Realtime session tokens

Posting to `/secure/realtime-token` mints a short-lived OpenAI Realtime session configured for voice and text streaming. The response contains the session token your browser client should pass to OpenAI’s WebRTC/WebSocket endpoint. When the model issues a `function_call` named `secure_ping`, your client is responsible for calling `/secure/ping` with the bearer token and returning the result to the model.

## Frontend PoC

The `frontend/` directory hosts a Vite + React proof-of-concept that exercises the secure APIs from a browser and surfaces the debug stream.

### Configure

1. Generate a config file with the API URL:
   ```bash
   npm install             # only required once to install repo deps
   npx cdk deploy OpssageStack --outputs-file frontend/config/runtime.json
   ```
   Alternatively copy `frontend/config/runtime.template.json` to `runtime.json` and fill in the `apiBaseUrl`.
   The frontend loader accepts both flattened config (`{ "apiBaseUrl": "…" }`) and the raw CDK outputs JSON; it will extract `ApiBaseUrl` automatically.
2. Install dependencies (run inside `frontend/`):
   ```bash
   cd frontend
   npm install
   ```
   The root and `frontend/` `node_modules` directories are ignored via `.gitignore`, so you can install locally without tracking the generated files. If `npm` drops a `frontend/package-lock.json`, remove it (`rm frontend/package-lock.json`) before committing to keep the repo lockfile-free.

### Develop locally

```bash
cd frontend
npm run dev
```

Navigate to <http://localhost:5173>, paste your bearer token, and click **Enable session** to request a realtime token. The expanding debug panel colour-codes traffic `to/from aws` and `to/from gpt`.

### CI workflow

The GitHub Actions workflow in `.github/workflows/frontend.yml` runs on every push (and `workflow_dispatch`). It installs dependencies, ensures the config placeholder exists, and builds the app so infrastructure changes that affect the frontend configuration fail fast.

## GitHub Actions IAM setup

The workflow assumes an IAM role using GitHub OIDC. Create a role in the target account named `github-actions-deploy-general` (matches `AWS_ROLE_NAME`), with:

- **Trust policy** that allows `sts:AssumeRoleWithWebIdentity` from `token.actions.githubusercontent.com`, constrained to your repo and `workflow:push` or `ref:refs/heads/main`.
- **Permissions policy** granting least-privilege access for CDK: CloudFormation deploy/update, IAM pass role for CDK bootstrap roles, Lambda, API Gateway, Secrets Manager, and related services used in the stack.

Example trust relationship snippet:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Update `<account-id>`, `<owner>`, and `<repo>` accordingly, and add additional `StringLike` entries if you also want to allow manual `workflow_dispatch`. Attach a permissions policy that covers `cloudformation:*`, `iam:PassRole` for the CDK bootstrap roles, and the specific services the stack provisions (Lambda, API Gateway, Secrets Manager, etc.).

Example permissions policy (replace placeholders):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeBootstrapRoles",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::<account-id>:role/cdk-hnb659fds-*"
    },
    {
      "Sid": "BootstrapArtifacts",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-hnb659fds-assets-<account-id>-<region>",
        "arn:aws:s3:::cdk-hnb659fds-assets-<account-id>-<region>/*"
      ]
    },
    {
      "Sid": "DeployStackResources",
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "lambda:*",
        "apigateway:*",
        "secretsmanager:*",
        "logs:*",
        "iam:GetRole",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy"
      ],
      "Resource": "*"
    }
  ]
}
```

Adjust the service actions to match the resources your stack provisions. The wildcard CloudFormation statement is typical for CDK pipelines so the deployment can create or update stacks; tighten it further if you know the exact services being managed.

### Running the workflows

- **Automatic deploys** run whenever code is pushed to `main`.
- **Manual deploys or undeploys**: open the workflow in GitHub Actions, click *Run workflow*, choose the `action` (`deploy` or `destroy`), and optionally set `stack_name`. Selecting `destroy` runs `cdk destroy --force` so double-check the stack before confirming.

## Testing the bearer-protected API

After the GitHub Actions workflow finishes deploying `OpssageStack`, you can exercise the secured endpoint with these steps:

1. **Fetch stack outputs** (grabs both `ApiBaseUrl` and `SecretName`):
   ```bash
   aws cloudformation describe-stacks \
    --stack-name OpssageStack \
     --query "Stacks[0].Outputs" \
     --output table \
     --region "${AWS_REGION}"
   ```
2. **Set the accepted bearer token** (swap `<token>` for the value you want Secrets Manager to hold):
   ```bash
   SECRET_NAME=$(aws cloudformation describe-stacks \
     --stack-name OpssageStack \
     --query "Stacks[0].Outputs[?OutputKey=='SecretName'].OutputValue" \
     --output text \
     --region "${AWS_REGION}")
   aws secretsmanager put-secret-value \
     --secret-id "$SECRET_NAME" \
     --secret-string '<token>' \
     --region "${AWS_REGION}"
   ```
3. **Call the secured endpoint**:
   ```bash
   curl -i \
     -H "Authorization: Bearer <token>" \
     "$(API_BASE_URL)/secure/ping?number=42"
   ```
   - Valid token → HTTP 200 with a JSON body (for example `{"ok": true, ..., "message": "you sent me 42"}`).
   - Missing or incorrect token → HTTP 401.
   - Omit the `number` parameter to receive a `message` of `"you sent me nothing"`.

Console workflow alternative: open `OpssageStack` in CloudFormation to copy the outputs, update the secret in Secrets Manager, then invoke the URL through a tool like Postman.
