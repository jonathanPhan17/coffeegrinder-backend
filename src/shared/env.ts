// Runtime environment contract — the names the CDK ApiStack injects into the lith.
export const TABLE_NAME = process.env.TABLE_NAME ?? '';
export const BUCKET_NAME = process.env.BUCKET_NAME ?? '';
export const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? '';
export const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

// Apify fetch workers only. Token param is an SSM SecureString name (decrypted at runtime,
// never inlined); actor id is the store slug the run starts.
export const APIFY_TOKEN_PARAM = process.env.APIFY_TOKEN_PARAM ?? '';
export const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID ?? '';
