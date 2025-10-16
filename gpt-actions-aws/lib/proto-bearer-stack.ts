import * as path from 'path';
import {
  Duration,
  Stack,
  StackProps,
  CfnOutput,
  RemovalPolicy,
  CfnParameter,
  CfnCondition,
  Fn,
  Token,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  HttpApi,
  CorsHttpMethod,
  HttpMethod,
  CfnStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class ProtoBearerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const existingBearerSecretArn = new CfnParameter(this, 'ExistingBearerSecretArn', {
      type: 'String',
      default: '',
      description: 'Optional ARN of an existing bearer token secret to reuse. Leave blank to create one.',
    });

    const existingBearerSecretName = new CfnParameter(this, 'ExistingBearerSecretName', {
      type: 'String',
      default: '',
      description: 'Optional name of the existing bearer secret (required when reusing an existing secret).',
    });

    const existingOpenAiSecretArn = new CfnParameter(this, 'ExistingOpenAiSecretArn', {
      type: 'String',
      default: '',
      description: 'Optional ARN of an existing OpenAI API key secret to reuse. Leave blank to create one.',
    });

    const existingOpenAiSecretName = new CfnParameter(this, 'ExistingOpenAiSecretName', {
      type: 'String',
      default: '',
      description: 'Optional name of the existing OpenAI API key secret (required when reusing an existing secret).',
    });

    const secretName = `${this.stackName}/opssage/bearer-token`;

    const createBearerSecretCondition = new CfnCondition(this, 'CreateBearerSecretCondition', {
      expression: Fn.conditionEquals(existingBearerSecretArn.valueAsString, ''),
    });

    const createOpenAiSecretCondition = new CfnCondition(this, 'CreateOpenAiSecretCondition', {
      expression: Fn.conditionEquals(existingOpenAiSecretArn.valueAsString, ''),
    });

    const bearerSecret = new secretsmanager.Secret(this, 'OpssageBearerSecret', {
      secretName,
    });
    bearerSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const bearerSecretResource = bearerSecret.node.defaultChild as secretsmanager.CfnSecret;
    bearerSecretResource.cfnOptions.condition = createBearerSecretCondition;

    const openAiSecret = new secretsmanager.Secret(this, 'OpenAiApiKeySecret', {
      secretName: `${this.stackName}/openai/api-key`,
    });
    openAiSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const openAiSecretResource = openAiSecret.node.defaultChild as secretsmanager.CfnSecret;
    openAiSecretResource.cfnOptions.condition = createOpenAiSecretCondition;

    const realtimeBurstLimit = new CfnParameter(this, 'RealtimeTokenBurstLimit', {
      type: 'Number',
      default: 5,
      minValue: 1,
      description: 'API Gateway burst limit for the realtime token route.',
    });

    const realtimeRateLimit = new CfnParameter(this, 'RealtimeTokenRateLimit', {
      type: 'Number',
      default: 10,
      minValue: 1,
      description: 'API Gateway steady-state rate limit (requests per second) for the realtime token route.',
    });

    const realtimeModel = new CfnParameter(this, 'RealtimeModelName', {
      type: 'String',
      default: 'gpt-4o-realtime-preview',
      description: 'OpenAI model to request when minting realtime sessions.',
    });

    const authorizerFunction = new lambda.Function(this, 'AuthorizerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'auth.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'src')),
      environment: {
        SECRET_NAME: Token.asString(
          Fn.conditionIf(
            createBearerSecretCondition.logicalId,
            bearerSecret.secretName,
            existingBearerSecretName.valueAsString,
          ),
        ),
      },
      description: 'Validates bearer tokens against Secrets Manager',
      functionName: `${this.stackName}-authorizer`,
    });

    authorizerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          Token.asString(
            Fn.conditionIf(
              createBearerSecretCondition.logicalId,
              bearerSecret.secretArn,
              existingBearerSecretArn.valueAsString,
            ),
          ),
        ],
      }),
    );

    const apiFunction = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'app.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'src')),
      description: 'Handles secure ping requests',
      functionName: `${this.stackName}-secure-api`,
    });

    const realtimeTokenFunction = new lambda.Function(this, 'RealtimeTokenFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'realtime_token.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'src')),
      environment: {
        SECRET_NAME: Token.asString(
          Fn.conditionIf(
            createBearerSecretCondition.logicalId,
            bearerSecret.secretName,
            existingBearerSecretName.valueAsString,
          ),
        ),
        OPENAI_API_KEY_SECRET_ARN: Token.asString(
          Fn.conditionIf(
            createOpenAiSecretCondition.logicalId,
            openAiSecret.secretArn,
            existingOpenAiSecretArn.valueAsString,
          ),
        ),
        REALTIME_MODEL: realtimeModel.valueAsString,
      },
      description: 'Mints short-lived OpenAI realtime session tokens for authorised clients',
      functionName: `${this.stackName}-realtime-token`,
      timeout: Duration.seconds(10),
    });

    realtimeTokenFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          Token.asString(
            Fn.conditionIf(
              createBearerSecretCondition.logicalId,
              bearerSecret.secretArn,
              existingBearerSecretArn.valueAsString,
            ),
          ),
          Token.asString(
            Fn.conditionIf(
              createOpenAiSecretCondition.logicalId,
              openAiSecret.secretArn,
              existingOpenAiSecretArn.valueAsString,
            ),
          ),
        ],
      }),
    );

    const httpApi = new HttpApi(this, 'OpssageHttpApi', {
      apiName: `${this.stackName}-proto-bearer-api`,
      createDefaultStage: false,
      corsPreflight: {
        allowHeaders: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
        maxAge: Duration.hours(1),
      },
    });

    const authorizer = new HttpLambdaAuthorizer('OpssageAuthorizer', authorizerFunction, {
      identitySource: ['$request.header.Authorization'],
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: Duration.seconds(0),
    });

    const realtimeTokenFunction = new lambda.Function(this, 'RealtimeTokenFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'realtime_token.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'src')),
      environment: {
        SECRET_NAME: secretName,
        OPENAI_API_KEY_SECRET_ARN: openAiSecret.secretArn,
        REALTIME_MODEL: realtimeModel.valueAsString,
        API_BASE_URL: httpApi.apiEndpoint,
      },
      description: 'Mints short-lived OpenAI realtime session tokens for authorised clients',
      functionName: `${this.stackName}-realtime-token`,
      timeout: Duration.seconds(10),
    });

    realtimeTokenFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          bearerSecret.secretArn,
          openAiSecret.secretArn,
        ],
      }),
    );

    httpApi.addRoutes({
      path: '/secure/ping',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PingIntegration', apiFunction),
      authorizer,
    });

    httpApi.addRoutes({
      path: '/secure/realtime-token',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('RealtimeTokenIntegration', realtimeTokenFunction),
      authorizer,
    });

    const stage = new CfnStage(this, 'OpssageDefaultStage', {
      apiId: httpApi.apiId,
      stageName: '$default',
      autoDeploy: true,
    });

    stage.addPropertyOverride(
      'RouteSettings.POST ~1secure~1realtime-token.ThrottlingBurstLimit',
      realtimeBurstLimit.valueAsNumber,
    );
    stage.addPropertyOverride(
      'RouteSettings.POST ~1secure~1realtime-token.ThrottlingRateLimit',
      realtimeRateLimit.valueAsNumber,
    );

    realtimeTokenFunction.addEnvironment('API_BASE_URL', httpApi.apiEndpoint);

    realtimeTokenFunction.addEnvironment('API_BASE_URL', httpApi.apiEndpoint);

    new CfnOutput(this, 'ApiBaseUrl', {
      value: httpApi.apiEndpoint,
    });

    new CfnOutput(this, 'SecretName', {
      value: Token.asString(
        Fn.conditionIf(
          createBearerSecretCondition.logicalId,
          bearerSecret.secretName,
          existingBearerSecretName.valueAsString,
        ),
      ),
    });

    new CfnOutput(this, 'OpenAiSecretArn', {
      value: Token.asString(
        Fn.conditionIf(
          createOpenAiSecretCondition.logicalId,
          openAiSecret.secretArn,
          existingOpenAiSecretArn.valueAsString,
        ),
      ),
    });
  }
}
