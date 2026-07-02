import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface ApiStackProps extends StackProps {
  config: EnvConfig;
  table: TableV2;
  bucket: Bucket;
}

// Stateless layer: a single Fastify "lith" Lambda behind the HTTP API's default
// integration, so Fastify owns route dispatch. Consumes the data layer via
// explicit props (never globals) and is granted least-privilege access to it.
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, 'FastifyLith', {
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        // Bundle the AWS SDK v3 rather than relying on the Lambda runtime — the
        // s3-request-presigner is not guaranteed to be runtime-provided.
        externalModules: [],
      },
    });

    props.table.grantReadWriteData(fn);
    props.bucket.grantReadWrite(fn);

    const api = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('Lith', fn),
      corsPreflight: props.config.allowedOrigins.length
        ? {
            allowOrigins: props.config.allowedOrigins,
            allowMethods: [
              CorsHttpMethod.GET,
              CorsHttpMethod.POST,
              CorsHttpMethod.PATCH,
              CorsHttpMethod.OPTIONS,
            ],
            allowHeaders: ['Content-Type', 'Authorization'],
            maxAge: Duration.days(1),
          }
        : undefined,
    });

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
