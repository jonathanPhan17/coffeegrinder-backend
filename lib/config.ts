import type { App } from 'aws-cdk-lib';

export interface EnvConfig {
  envName: string;
  isProd: boolean;
  /** Origins allowed to call the API / upload to S3 (CORS). */
  allowedOrigins: string[];
  /** Bedrock model / inference-profile id for LLM calls; set via `-c bedrockModelId=…` or BEDROCK_MODEL_ID. */
  bedrockModelId: string;
}

const DEV_ORIGINS = ['http://localhost:5173'];

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
  };
}
