import { ConverseCommand, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { bedrock } from '../shared/bedrock';
import { BEDROCK_MODEL_ID } from '../shared/env';
import { logger } from '../shared/logger';

// Structured screening criteria distilled from a job posting (§5). Internal shape (not
// part of the frontend contract); Zod is the trust boundary for the LLM output.
export const PostingCriteriaSchema = z.object({
  must_haves: z.array(z.string()),
  nice_to_haves: z.array(z.string()),
  dealbreakers: z.array(z.string()),
});

export type PostingCriteria = z.infer<typeof PostingCriteriaSchema>;

const TOOL_NAME = 'emit_criteria';

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    must_haves: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hard requirements the candidate must meet (skills, years, credentials).',
    },
    nice_to_haves: {
      type: 'array',
      items: { type: 'string' },
      description: 'Preferred-but-optional qualifications that strengthen a candidate.',
    },
    dealbreakers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Disqualifiers — e.g. required on-site location, clearance, work authorization.',
    },
  },
  required: ['must_haves', 'nice_to_haves', 'dealbreakers'],
};

const SYSTEM_PROMPT =
  'You distill a job posting into concrete screening criteria. Return your answer only by ' +
  `calling the ${TOOL_NAME} tool. Extract atomic, checkable criteria straight from the posting ` +
  '— never invent requirements it does not state. Split compound requirements into separate items.';

async function invokeEmitCriteria(jdText: string): Promise<unknown> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: jdText }] }],
      inferenceConfig: { temperature: 0, maxTokens: 2048 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: TOOL_NAME,
              description: 'Emit the structured screening criteria extracted from the posting.',
              inputSchema: { json: TOOL_INPUT_SCHEMA },
            },
          },
        ],
        toolChoice: { tool: { name: TOOL_NAME } },
      },
    }),
  );

  const content: ContentBlock[] = response.output?.message?.content ?? [];
  return content.find((block) => block.toolUse?.name === TOOL_NAME)?.toolUse?.input;
}

export async function extractCriteria(jdText: string): Promise<PostingCriteria> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await invokeEmitCriteria(jdText);
    const parsed = PostingCriteriaSchema.safeParse(raw);
    if (parsed.success) return parsed.data;

    logger.warn('posting criteria failed schema validation', {
      attempt,
      issues: parsed.error.issues,
    });
  }

  throw new Error('posting criteria failed schema validation after retry');
}
