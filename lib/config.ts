import type { App } from 'aws-cdk-lib';

export interface EnvConfig {
  envName: string;
  isProd: boolean;
  /** Origins allowed to call the API / upload to S3 (CORS). */
  allowedOrigins: string[];
}

const DEV_ORIGINS = ['http://localhost:5173'];

export function loadConfig(app: App): EnvConfig {
  const envName =
    (app.node.tryGetContext('env') as string | undefined) ?? process.env.CDK_ENV ?? 'dev';
  const isProd = envName === 'prod';
  return {
    envName,
    isProd,
    allowedOrigins: isProd ? [] : DEV_ORIGINS,
  };
}
