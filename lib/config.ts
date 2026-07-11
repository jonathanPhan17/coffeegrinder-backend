import type { App } from 'aws-cdk-lib';

export interface EnvConfig {
  envName: string;
  isProd: boolean;
  /** Origins allowed to call the API / upload to S3 (CORS). */
  allowedOrigins: string[];
  /** Bedrock model / inference-profile id for LLM calls; set via `-c bedrockModelId=…` or BEDROCK_MODEL_ID. */
  bedrockModelId: string;
  /** SSM SecureString name holding the Apify API token (decrypted at runtime by the fetch workers). */
  apifyTokenParam: string;
  /** Apify store actor the Fetch stage runs (§9.7). */
  apifyActorId: string;
}

const DEV_ORIGINS = ['http://localhost:5173'];

const DEFAULT_APIFY_TOKEN_PARAM = '/coffeegrinder/apify-token';
const DEFAULT_APIFY_ACTOR_ID = 'misceres/indeed-scraper';

export function loadConfig(app: App): EnvConfig {
  const envName =
    (app.node.tryGetContext('env') as string | undefined) ?? process.env.CDK_ENV ?? 'dev';
  const isProd = envName === 'prod';
  const bedrockModelId =
    (app.node.tryGetContext('bedrockModelId') as string | undefined) ??
    process.env.BEDROCK_MODEL_ID ??
    '';
  return {
    envName,
    isProd,
    allowedOrigins: isProd ? [] : DEV_ORIGINS,
    bedrockModelId,
    apifyTokenParam:
      (app.node.tryGetContext('apifyTokenParam') as string | undefined) ??
      DEFAULT_APIFY_TOKEN_PARAM,
    apifyActorId:
      (app.node.tryGetContext('apifyActorId') as string | undefined) ?? DEFAULT_APIFY_ACTOR_ID,
  };
}
