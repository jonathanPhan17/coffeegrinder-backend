import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// One client per container; region comes from the Lambda's AWS_REGION.
export const bedrock = new BedrockRuntimeClient({});
