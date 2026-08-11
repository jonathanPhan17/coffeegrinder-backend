import { z } from 'zod';
import { callTool } from './tool-call';

/**
 * Structured screening criteria distilled from a job posting (§5). Internal shape (not
 * part of the frontend contract); Zod is the trust boundary for the LLM output.
 */
export const PostingCriteriaSchema = z.object({
  must_haves: z.array(z.string()),
  nice_to_haves: z.array(z.string()),
  dealbreakers: z.array(z.string()),
});

export type PostingCriteria = z.infer<typeof PostingCriteriaSchema>;

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
      description:
        "Hard pass/fail constraints. Phrase each as a REQUIREMENT the candidate must satisfy, so that meeting it is good — e.g. 'Authorized to work in the US without sponsorship', 'Willing to work on-site in NYC'. Never phrase as a disqualifier (not 'Requires sponsorship').",
    },
  },
  required: ['must_haves', 'nice_to_haves', 'dealbreakers'],
};

const SYSTEM_PROMPT =
  'You distill a job posting into concrete screening criteria. Return your answer only by ' +
  'calling the emit_criteria tool. Extract atomic, checkable criteria straight from the posting ' +
  '— never invent requirements it does not state. Split compound requirements into separate items.';

export function extractCriteria(jdText: string): Promise<PostingCriteria> {
  return callTool(PostingCriteriaSchema, {
    toolName: 'emit_criteria',
    toolDescription: 'Emit the structured screening criteria extracted from the posting.',
    inputSchema: { json: TOOL_INPUT_SCHEMA },
    systemPrompt: SYSTEM_PROMPT,
    userText: jdText,
    label: 'posting criteria',
    // Extraction-class task: pull stated requirements out of one document, no cross-document
    // judgment. Quality-sensitive scoring stays on the standard tier; a scoring-model change
    // goes through scripts/scoring-benchmark.ts first.
    tier: 'fast',
  });
}
