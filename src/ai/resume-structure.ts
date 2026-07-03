import { ConverseCommand, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { bedrock } from '../shared/bedrock';
import { BEDROCK_MODEL_ID } from '../shared/env';
import { logger } from '../shared/logger';

// The structured, AI-owned subset of ResumeProfile (§8 contract). Zod is the trust
// boundary for every LLM output — nothing reaches DynamoDB unvalidated.
export const StructuredProfileSchema = z.object({
  targetRole: z.string(),
  experience: z.string(),
  education: z.string(),
  skills: z.array(z.string()),
});

export type StructuredProfile = z.infer<typeof StructuredProfileSchema>;

const TOOL_NAME = 'emit_profile';

// JSON Schema handed to Bedrock so forced tool-use pins the response to this shape.
const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    targetRole: {
      type: 'string',
      description:
        "The single role the candidate is targeting — their most senior or headline title, e.g. 'Senior Backend Engineer'.",
    },
    experience: {
      type: 'string',
      description: "A concise 2-4 sentence prose summary of the candidate's work experience.",
    },
    education: {
      type: 'string',
      description: "A concise summary of the candidate's education (degrees, institutions).",
    },
    skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'A flat, deduplicated list of concrete skills and technologies named in the resume.',
    },
  },
  required: ['targetRole', 'experience', 'education', 'skills'],
};

const SYSTEM_PROMPT =
  'You extract a structured professional profile from raw resume text. ' +
  `Return your answer only by calling the ${TOOL_NAME} tool. Stay faithful to the ` +
  'resume — never invent roles, skills, or credentials the text does not support. ' +
  'Summarize concisely.';

async function invokeEmitProfile(resumeText: string): Promise<unknown> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: resumeText }] }],
      inferenceConfig: { temperature: 0, maxTokens: 2048 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: TOOL_NAME,
              description: 'Emit the structured profile extracted from the resume.',
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

// Grounded, schema-validated structuring. Forced tool-use keeps the shape tight; Zod
// verifies it and we retry once before giving up. Failure throws to the worker, which
// lets EventBridge retry the whole parse.
export async function structureResume(resumeText: string): Promise<StructuredProfile> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await invokeEmitProfile(resumeText);
    const parsed = StructuredProfileSchema.safeParse(raw);
    if (parsed.success) return parsed.data;

    logger.warn('resume structuring failed schema validation', {
      attempt,
      issues: parsed.error.issues,
    });
  }

  throw new Error('resume structuring failed schema validation after retry');
}
