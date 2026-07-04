import { z } from 'zod';
import type { PostingCriteria } from './posting-criteria';
import { callTool } from './tool-call';

// One per-criterion verdict from the model, BEFORE the deterministic Verify step and the
// code-computed score. `quote` must be a verbatim résumé snippet for met/partial (empty
// for not_met); Verify string-matches it against the résumé. The model never scores.
export const ScoredCriterionSchema = z.object({
  criterion: z.string(),
  group: z.enum(['must_have', 'nice_to_have', 'dealbreaker']),
  verdict: z.enum(['met', 'partial', 'not_met']),
  confidence: z.number(),
  quote: z.string(),
  reasoning: z.string(),
});

export const ScoreResultSchema = z.object({
  criteria: z.array(ScoredCriterionSchema),
  summary: z.string(),
});

export type ScoredCriterion = z.infer<typeof ScoredCriterionSchema>;
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

const CRITERION_SCHEMA = {
  type: 'object',
  properties: {
    criterion: { type: 'string', description: 'The criterion evaluated, copied from the input.' },
    group: { type: 'string', enum: ['must_have', 'nice_to_have', 'dealbreaker'] },
    verdict: { type: 'string', enum: ['met', 'partial', 'not_met'] },
    confidence: { type: 'number', description: 'Confidence in the verdict, 0 to 1.' },
    quote: {
      type: 'string',
      description:
        'A VERBATIM sentence copied exactly from the résumé that supports a met/partial verdict. Empty string for not_met.',
    },
    reasoning: { type: 'string', description: 'One sentence explaining the verdict.' },
  },
  required: ['criterion', 'group', 'verdict', 'confidence', 'quote', 'reasoning'],
};

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: CRITERION_SCHEMA,
      description: 'One entry per input criterion, across all three groups.',
    },
    summary: { type: 'string', description: 'A one-line overall fit summary.' },
  },
  required: ['criteria', 'summary'],
};

const SYSTEM_PROMPT =
  "You score a candidate's résumé against a job posting's screening criteria. For EVERY " +
  'criterion, decide met / partial / not_met from the résumé, give a one-sentence reasoning, ' +
  'a confidence from 0 to 1, and — for met or partial — a quote copied VERBATIM from the résumé ' +
  'that supports the verdict (use an empty string for not_met). Also write a one-line overall ' +
  'summary. Do NOT compute a numeric score. Return your answer only by calling the emit_scorecard tool.';

function formatCriteria(criteria: PostingCriteria): string {
  const section = (title: string, items: string[]): string =>
    `${title}:\n${items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)'}`;
  return [
    section('Must-haves', criteria.must_haves),
    section('Nice-to-haves', criteria.nice_to_haves),
    section('Dealbreakers', criteria.dealbreakers),
  ].join('\n\n');
}

export function scoreMatch(resumeText: string, criteria: PostingCriteria): Promise<ScoreResult> {
  return callTool(ScoreResultSchema, {
    toolName: 'emit_scorecard',
    toolDescription: 'Emit the per-criterion scorecard for the résumé against the posting.',
    inputSchema: { json: TOOL_INPUT_SCHEMA },
    systemPrompt: SYSTEM_PROMPT,
    userText: `Résumé:\n${resumeText}\n\nScreening criteria:\n${formatCriteria(criteria)}`,
    label: 'match scoring',
    // Sized for the worst case (~20 criteria × verdict + reasoning + verbatim quote).
    maxTokens: 4096,
  });
}
