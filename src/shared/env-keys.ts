/**
 * Environment variable names shared by the CDK stacks (writers, lib/api-stack.ts) and the
 * runtime (readers, src/shared/env.ts). Both sides import these so a renamed or mistyped
 * key is a compile error instead of a runtime empty string.
 */
export const ENV_KEYS = {
  tableName: 'TABLE_NAME',
  bucketName: 'BUCKET_NAME',
  bedrockModelId: 'BEDROCK_MODEL_ID',
  stateMachineArn: 'STATE_MACHINE_ARN',
  apifyTokenParam: 'APIFY_TOKEN_PARAM',
  apifyActorId: 'APIFY_ACTOR_ID',
} as const;
