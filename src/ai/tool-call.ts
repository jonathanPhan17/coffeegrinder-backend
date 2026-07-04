import {
  ConverseCommand,
  type ContentBlock,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';
import type { ZodType } from 'zod';
import { bedrock } from '../shared/bedrock';
import { BEDROCK_MODEL_ID } from '../shared/env';
import { logger } from '../shared/logger';

export interface ToolCallSpec {
  toolName: string;
  toolDescription: string;
  /** Pass `{ json: <JSON Schema object> }`. */
  inputSchema: ToolInputSchema;
  systemPrompt: string;
  userText: string;
  /** Used in logs and the failure message. */
  label: string;
  maxTokens?: number;
}

// The shared spine for every structured LLM extraction (resume profile, posting criteria,
// match scorecard): one grounded Bedrock call via forced tool-use, Zod-validated with a
// single retry. A max_tokens stop or a missing tool block counts as a failed attempt —
// never parsed as a truncated result. Throws after the retry so callers surface failure.
export async function callTool<T>(schema: ZodType<T>, spec: ToolCallSpec): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await invokeTool(spec);
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;

    logger.warn(`${spec.label} failed schema validation`, {
      attempt,
      issues: parsed.error.issues,
    });
  }

  throw new Error(`${spec.label} failed schema validation after retry`);
}

async function invokeTool(spec: ToolCallSpec): Promise<unknown> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: spec.systemPrompt }],
      messages: [{ role: 'user', content: [{ text: spec.userText }] }],
      inferenceConfig: { temperature: 0, maxTokens: spec.maxTokens ?? 2048 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: spec.toolName,
              description: spec.toolDescription,
              inputSchema: spec.inputSchema,
            },
          },
        ],
        toolChoice: { tool: { name: spec.toolName } },
      },
    }),
  );

  // A truncated response is a failed attempt, never a short-but-valid scorecard.
  if (response.stopReason === 'max_tokens') {
    logger.warn(`${spec.label} response truncated at max_tokens`);
    return undefined;
  }

  const content: ContentBlock[] = response.output?.message?.content ?? [];
  return content.find((block) => block.toolUse?.name === spec.toolName)?.toolUse?.input;
}
