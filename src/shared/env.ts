// Runtime environment contract — the names the CDK ApiStack injects into the lith.
export const TABLE_NAME = process.env.TABLE_NAME ?? '';
export const BUCKET_NAME = process.env.BUCKET_NAME ?? '';
export const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? '';
