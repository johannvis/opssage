import * as path from 'path';
import { Duration, Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpApi, CorsHttpMethod, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class ProtoBearerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const secretName = `${this.stackName}/gptapitest/bearer-token`;

    const bearerSecret = new secretsmanager.Secret(this, 'PrototypeTokenSecret', {
      secretName: secretName,
    });
    bearerSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const authorizerFunction = new lambda.Function(this, 'AuthorizerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'auth.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'src')),
      environment: {
        SECRET_NAME: secretName,
      },
      description: 'Validates bearer tokens against Secrets Manager',
      functionName: `${this.stackName}-authorizer`,
    });

    authorizerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [bearerSecret.secretArn],
      }),
    );

    const apiFunction = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'app.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'src')),
      description: 'Handles secure ping requests',
      functionName: `${this.stackName}-secure-api`,
    });

    const httpApi = new HttpApi(this, 'ProtoBearerHttpApi', {
      apiName: `${this.stackName}-proto-bearer-api`,
      corsPreflight: {
        allowHeaders: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
        maxAge: Duration.hours(1),
      },
    });

    const authorizer = new HttpLambdaAuthorizer('ProtoBearerAuthorizer', authorizerFunction, {
      identitySource: ['$request.header.Authorization'],
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: Duration.seconds(0),
    });

    httpApi.addRoutes({
      path: '/secure/ping',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PingIntegration', apiFunction),
      authorizer,
    });

    new CfnOutput(this, 'ApiBaseUrl', {
      value: httpApi.apiEndpoint,
    });

    new CfnOutput(this, 'SecretName', {
      value: secretName,
    });
  }
}
