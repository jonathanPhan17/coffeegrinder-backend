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
  /**
   * Apex domain the public site is served on (www and, later, api hang off its zone).
   * Registered at an external registrar; DNS is delegated to the Route 53 zone the
   * DnsStack owns. One domain exists, so deploy the frontend stacks in exactly one env.
   */
  frontendDomain: string;
}

const DEV_ORIGINS = ['http://localhost:5173'];

const DEFAULT_FRONTEND_DOMAIN = 'coffeegrinder.app';

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
  const frontendDomain =
    (app.node.tryGetContext('frontendDomain') as string | undefined) ?? DEFAULT_FRONTEND_DOMAIN;
  // The deployed site calls the API cross-origin, exactly like localhost does.
  const siteOrigins = [`https://${frontendDomain}`, `https://www.${frontendDomain}`];
  return {
    envName,
    isProd,
    allowedOrigins: isProd ? [] : [...DEV_ORIGINS, ...siteOrigins],
    bedrockModelId,
    apifyTokenParam:
      (app.node.tryGetContext('apifyTokenParam') as string | undefined) ??
      DEFAULT_APIFY_TOKEN_PARAM,
    apifyActorId:
      (app.node.tryGetContext('apifyActorId') as string | undefined) ?? DEFAULT_APIFY_ACTOR_ID,
    frontendDomain,
  };
}
