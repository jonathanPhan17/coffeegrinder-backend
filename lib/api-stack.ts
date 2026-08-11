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
import { ENV_KEYS } from '../src/shared/env-keys';
import type { EnvConfig } from './config';
import { MatchingMachine } from './constructs/matching-machine';

export interface ApiStackProps extends StackProps {
  config: EnvConfig;
  table: TableV2;
  bucket: Bucket;
}

const WORKERS_DIR = path.join(__dirname, '..', 'src', 'workers');

/**
 * Stateless layer: a single Fastify "lith" Lambda behind the HTTP API's default integration
 * (Fastify owns route dispatch) plus the async worker Lambdas that back the matching pipeline.
 * Consumes the data layer via explicit props and is granted least-privilege access to it.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    if (!props.config.bedrockModelId) {
      throw new Error(
        'ApiStack requires bedrockModelId — set it via `-c bedrockModelId=<id>` or the BEDROCK_MODEL_ID env var.',
      );
    }

    // Each AI worker is granted only the model its calls actually bill to, mirroring the
    // runtime fallback in src/ai/tool-call.ts (fast tier → BEDROCK_FAST_MODEL_ID, else the
    // standard id). For the fast-tier workers a wrong-tier call is a loud AccessDenied in
    // dev. ScorePosting is the deliberate asymmetry: it carries no fast id, so a tier flip
    // in score-match.ts alone would silently fall back to the standard model — a scoring
    // swap changes bedrockModelId (or this stack's env + grant in the same diff), never
    // only the tier at the call site.
    const fastModelId = props.config.bedrockFastModelId || props.config.bedrockModelId;
    const grantBedrock = (fn: NodejsFunction, modelId: string): void => {
      fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: bedrockInvokeResources(modelId, this.region, this.account),
        }),
      );
    };

    // Fast-tier workers still carry the standard id so the runtime fallback stays coherent;
    // the fast id is injected only when configured (empty means "no split").
    const fastTierEnv: Record<string, string> = {
      [ENV_KEYS.bedrockModelId]: props.config.bedrockModelId,
      ...(props.config.bedrockFastModelId
        ? { [ENV_KEYS.bedrockFastModelId]: props.config.bedrockFastModelId }
        : {}),
    };

    // Read the Apify token SecureString and decrypt it. The decrypt grant is scoped to the
    // AWS-managed SSM key via the ViaService condition (its per-account key id is not known at
    // synth time), so only SSM can use it on the worker's behalf.
    const grantApifyToken = (fn: NodejsFunction): void => {
      fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter${props.config.apifyTokenParam}`,
          ],
        }),
      );
      fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
        }),
      );
    };

    // The lith serves the HTTP API; it reads/writes the whole table, presigns uploads, and
    // starts matching runs.
    const lith = nodeFunction(this, 'FastifyLith', {
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      environment: {
        [ENV_KEYS.tableName]: props.table.tableName,
        [ENV_KEYS.bucketName]: props.bucket.bucketName,
      },
    });
    props.table.grantReadWriteData(lith);
    props.bucket.grantReadWrite(lith);

    // Resume parse worker: S3 ObjectCreated → extract text → structure → profile.
    // Its one LLM call (resume structuring) runs on the fast tier.
    const parseResume = nodeFunction(this, 'ParseResume', {
      entry: path.join(WORKERS_DIR, 'parse-resume.ts'),
      timeout: Duration.seconds(60),
      environment: {
        [ENV_KEYS.tableName]: props.table.tableName,
        [ENV_KEYS.bucketName]: props.bucket.bucketName,
        ...fastTierEnv,
      },
    });
    props.bucket.grantRead(parseResume);
    props.table.grantWriteData(parseResume);
    grantBedrock(parseResume, fastModelId);

    // Matching worker 1: posting JD → structured criteria on the posting item (fast tier).
    const extractCriteria = nodeFunction(this, 'ExtractCriteria', {
      entry: path.join(WORKERS_DIR, 'extract-criteria.ts'),
      timeout: Duration.seconds(60),
      environment: {
        [ENV_KEYS.tableName]: props.table.tableName,
        ...fastTierEnv,
      },
    });
    props.table.grantReadWriteData(extractCriteria);
    grantBedrock(extractCriteria, fastModelId);

    // Matching worker 2: grounded Score → code Verify → computed score → persist Match.
    // Scoring is the quality-sensitive call and stays on the standard model.
    const scorePosting = nodeFunction(this, 'ScorePosting', {
      entry: path.join(WORKERS_DIR, 'score-posting.ts'),
      timeout: Duration.seconds(180),
      environment: {
        [ENV_KEYS.tableName]: props.table.tableName,
        [ENV_KEYS.bedrockModelId]: props.config.bedrockModelId,
      },
    });
    props.table.grantReadWriteData(scorePosting);
    grantBedrock(scorePosting, props.config.bedrockModelId);

    // Apify Fetch workers (§9.7): the state machine's Fetch stage runs these in a
    // start → poll → collect loop. Only Start and Collect touch the table.
    const apifyEnv = {
      [ENV_KEYS.apifyTokenParam]: props.config.apifyTokenParam,
      [ENV_KEYS.apifyActorId]: props.config.apifyActorId,
    };
    const startActorRun = nodeFunction(this, 'StartActorRun', {
      entry: path.join(WORKERS_DIR, 'start-actor-run.ts'),
      timeout: Duration.seconds(30),
      environment: { [ENV_KEYS.tableName]: props.table.tableName, ...apifyEnv },
    });
    props.table.grantWriteData(startActorRun);
    grantApifyToken(startActorRun);

    const getActorStatus = nodeFunction(this, 'GetActorStatus', {
      entry: path.join(WORKERS_DIR, 'get-actor-status.ts'),
      timeout: Duration.seconds(15),
      environment: apifyEnv,
    });
    grantApifyToken(getActorStatus);

    const collectPostings = nodeFunction(this, 'CollectPostings', {
      entry: path.join(WORKERS_DIR, 'collect-postings.ts'),
      timeout: Duration.seconds(120),
      environment: { [ENV_KEYS.tableName]: props.table.tableName, ...apifyEnv },
    });
    props.table.grantWriteData(collectPostings);
    grantApifyToken(collectPostings);

    const matching = new MatchingMachine(this, 'MatchingMachine', {
      table: props.table,
      extractCriteria,
      scorePosting,
      startActorRun,
      getActorStatus,
      collectPostings,
    });
    matching.stateMachine.grantStartExecution(lith);
    lith.addEnvironment(ENV_KEYS.stateMachineArn, matching.stateMachine.stateMachineArn);

    const api = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('Lith', lith),
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

interface NodeFunctionOptions {
  entry: string;
  environment: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
}

/** Shared defaults for every Node Lambda in this stack (Node 20, arm64, SDK bundled in). */
function nodeFunction(scope: Construct, id: string, opts: NodeFunctionOptions): NodejsFunction {
  return new NodejsFunction(scope, id, {
    entry: opts.entry,
    handler: 'handler',
    runtime: Runtime.NODEJS_20_X,
    architecture: Architecture.ARM_64,
    timeout: opts.timeout,
    memorySize: opts.memorySize ?? 512,
    environment: opts.environment,
    bundling: {
      minify: true,
      sourceMap: true,
      // Bundle the AWS SDK v3 rather than relying on the Lambda runtime — the
      // s3-request-presigner is not guaranteed to be runtime-provided.
      externalModules: [],
    },
  });
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
