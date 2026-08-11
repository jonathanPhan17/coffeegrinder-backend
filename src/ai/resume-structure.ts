import { z } from 'zod';
import { callTool } from './tool-call';

/**
 * The structured, AI-owned subset of ResumeProfile (§8 contract). Zod is the trust
 * boundary for the LLM output — nothing reaches DynamoDB unvalidated.
 */
export const StructuredProfileSchema = z.object({
  targetRole: z.string(),
  experience: z.string(),
  education: z.string(),
  skills: z.array(z.string()),
});

export type StructuredProfile = z.infer<typeof StructuredProfileSchema>;

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
  'You extract a structured professional profile from raw resume text. Return your answer ' +
  'only by calling the emit_profile tool. Stay faithful to the resume — never invent roles, ' +
  'skills, or credentials the text does not support. Summarize concisely.';

export function structureResume(resumeText: string): Promise<StructuredProfile> {
  return callTool(StructuredProfileSchema, {
    toolName: 'emit_profile',
    toolDescription: 'Emit the structured profile extracted from the resume.',
    inputSchema: { json: TOOL_INPUT_SCHEMA },
    systemPrompt: SYSTEM_PROMPT,
    userText: resumeText,
    label: 'resume structuring',
    // Extraction-class task, same reasoning as posting-criteria: summarize one document into
    // fields the schema already constrains — the cheap tier handles it.
    tier: 'fast',
  });
}
