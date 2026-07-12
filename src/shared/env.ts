import { ENV_KEYS } from './env-keys';

/** Runtime environment contract — the names the CDK ApiStack injects into the lith. */
export const TABLE_NAME = process.env[ENV_KEYS.tableName] ?? '';
export const BUCKET_NAME = process.env[ENV_KEYS.bucketName] ?? '';
export const BEDROCK_MODEL_ID = process.env[ENV_KEYS.bedrockModelId] ?? '';
export const STATE_MACHINE_ARN = process.env[ENV_KEYS.stateMachineArn] ?? '';

/**
 * Apify fetch workers only. Token param is an SSM SecureString name (decrypted at runtime,
 * never inlined); actor id is the store slug the run starts.
 */
export const APIFY_TOKEN_PARAM = process.env[ENV_KEYS.apifyTokenParam] ?? '';
export const APIFY_ACTOR_ID = process.env[ENV_KEYS.apifyActorId] ?? '';
