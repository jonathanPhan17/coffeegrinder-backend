import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';
import { MatchingMachine } from './constructs/matching-machine';

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

    if (!props.config.bedrockModelId) {
      throw new Error(
        'ApiStack requires bedrockModelId — set it via `-c bedrockModelId=<id>` or the BEDROCK_MODEL_ID env var.',
      );
    }

    const matching = new MatchingMachine(this, 'MatchingMachine', { table: props.table });

    const fn = new NodejsFunction(this, 'FastifyLith', {
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        STATE_MACHINE_ARN: matching.stateMachine.stateMachineArn,
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
    matching.stateMachine.grantStartExecution(fn);

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

    // Async worker: parses an uploaded resume when S3 emits ObjectCreated.
    const parseResume = new NodejsFunction(this, 'ParseResume', {
      entry: path.join(__dirname, '..', 'src', 'workers', 'parse-resume.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        BEDROCK_MODEL_ID: props.config.bedrockModelId,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });

    props.bucket.grantRead(parseResume);
    props.table.grantWriteData(parseResume);
    parseResume.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: bedrockInvokeResources(props.config.bedrockModelId, this.region, this.account),
      }),
    );

    new Rule(this, 'ResumeUploadedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.bucket.bucketName] },
          object: { key: [{ prefix: 'resumes/' }] },
        },
      },
      targets: [new LambdaFunction(parseResume)],
    });
  }
}

// Resource ARNs for bedrock:InvokeModel. A cross-region inference profile
// (e.g. `us.anthropic.…`) needs both the profile ARN in the deploy account/region and
// the underlying foundation-model ARN with a wildcarded region, since the profile
// routes the call across regions. A bare foundation-model id needs only its one ARN.
// Either way the grant stays scoped to the single model.
const INFERENCE_PROFILE_GEOS = ['us', 'eu', 'apac'];

function bedrockInvokeResources(modelId: string, region: string, account: string): string[] {
  const dot = modelId.indexOf('.');
  const geo = dot > 0 ? modelId.slice(0, dot) : '';
  if (INFERENCE_PROFILE_GEOS.includes(geo)) {
    const foundationModelId = modelId.slice(dot + 1);
    return [
      `arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`,
      `arn:aws:bedrock:*::foundation-model/${foundationModelId}`,
    ];
  }
  return [`arn:aws:bedrock:${region}::foundation-model/${modelId}`];
}
