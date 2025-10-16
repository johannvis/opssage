#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProtoBearerStack } from '../gpt-actions-aws/lib/proto-bearer-stack';

const app = new cdk.App();

new ProtoBearerStack(app, 'OpssageStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
