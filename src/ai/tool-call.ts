import {
  ConverseCommand,
  type ContentBlock,
  type Message,
  type TokenUsage,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';
import type { ZodIssue, ZodType } from 'zod';
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
  /**
   * Stable text (e.g. the résumé) that repeats across calls in a batch. When set, a cache
   * checkpoint is placed right after it, so the system prompt, tool schema, and this prefix
   * are cached — ~90% cheaper and lower-latency on repeat within Bedrock's cache TTL. Omit
   * for one-shot or per-item calls where nothing repeats.
   */
  cachePrefix?: string;
  maxTokens?: number;
}

// Original call + 2 self-correcting retries. At temperature 0 a verbatim retry mostly
// reproduces the same malformed output, so each retry feeds the validation error back into
// the conversation (see withCorrection) rather than re-sending the identical prompt.
const MAX_ATTEMPTS = 3;

// Cap the raw model output we log on failure — enough to see whether a field came back as a
// stringified blob, without dumping a full scorecard into CloudWatch.
const RAW_INPUT_LOG_CAP = 4096;

interface AttemptResult {
  /** The assistant turn to replay when correcting, or undefined if the reply was empty. */
  assistantMessage: Message | undefined;
  /** Present only when the model actually called the tool; anchors a toolResult correction. */
  toolUseId: string | undefined;
  input: unknown;
  stopReason: string | undefined;
  usage: TokenUsage | undefined;
}

// The shared spine for every structured LLM extraction (resume profile, posting criteria,
// match scorecard): one grounded Bedrock call via forced tool-use, Zod-validated. On a failed
// attempt it logs a decision-grade entry (raw input, issues, stopReason, usage) and, if
// attempts remain, continues the conversation with the validation error so the model can
// repair in-context. Throws after the last attempt so callers surface failure.
export async function callTool<T>(schema: ZodType<T>, spec: ToolCallSpec): Promise<T> {
  // First turn carries the cached prefix + checkpoint (when set); the retry path spreads it
  // unchanged, so corrections read the same warm cache.
  let messages: Message[] = [userTurn(spec, spec.userText)];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await invokeTool(spec, messages);

    // A truncated (max_tokens) response is always a failed attempt — never accept a partial
    // tool call, even if the fragment happens to satisfy the schema.
    const parsed = res.stopReason === 'max_tokens' ? undefined : schema.safeParse(res.input);
    if (parsed?.success) {
      // Cache observability: usage carries cacheReadInputTokens / cacheWriteInputTokens.
      // Gated on cachePrefix so the success path stays silent for uncached calls.
      if (spec.cachePrefix) logger.info(`${spec.label} tokens`, { label: spec.label, usage: res.usage });
      return parsed.data;
    }

    const exhausted = attempt === MAX_ATTEMPTS;
    // One structured entry per failed attempt. `event` is a filterable enum: counting
    // `llm_validation_exhausted` per label gives the true drop rate, `llm_validation_retry`
    // the recoverable-flake rate. Upgrades to a metric filter later without touching callers.
    logger.warn(`${spec.label} failed schema validation`, {
      event: exhausted ? 'llm_validation_exhausted' : 'llm_validation_retry',
      label: spec.label,
      attempt,
      stopReason: res.stopReason,
      usage: res.usage,
      issues: parsed?.error.issues,
      rawInput: previewJson(res.input),
    });
    if (exhausted) break;

    messages = withCorrection(messages, res, parsed?.error.issues, spec);
  }

  throw new Error(`${spec.label} failed schema validation after retry`);
}

async function invokeTool(spec: ToolCallSpec, messages: Message[]): Promise<AttemptResult> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: spec.systemPrompt }],
      messages,
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

  const assistantMessage = response.output?.message;
  const content: ContentBlock[] = assistantMessage?.content ?? [];
  const toolUse = content.find((block) => block.toolUse?.name === spec.toolName)?.toolUse;
  return {
    assistantMessage,
    toolUseId: toolUse?.toolUseId,
    input: toolUse?.input,
    stopReason: response.stopReason,
    usage: response.usage,
  };
}

// The initial user turn: the cached prefix + checkpoint (when set), then the variable text.
// Shared by the first call and the correction fallback so both build the exact same shape —
// a fallback that dropped the prefix would retry a Score call without the résumé.
function userTurn(spec: ToolCallSpec, text: string): Message {
  const content: ContentBlock[] = spec.cachePrefix
    ? [{ text: spec.cachePrefix }, { cachePoint: { type: 'default' } }, { text }]
    : [{ text }];
  return { role: 'user', content };
}

// Build the next request that asks the model to fix its previous output.
function withCorrection(
  messages: Message[],
  res: AttemptResult,
  issues: ZodIssue[] | undefined,
  spec: ToolCallSpec,
): Message[] {
  const problem = issues?.length
    ? issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    : `no valid ${spec.toolName} tool call was returned${res.stopReason ? ` (stopReason: ${res.stopReason})` : ''}`;

  // Native correction: reference the model's own tool call with an error toolResult so it
  // repairs in-context. Requires a toolUseId, and the assistant turn that made the call must
  // precede the toolResult or Converse rejects the request.
  if (res.assistantMessage && res.toolUseId) {
    return [
      ...messages,
      res.assistantMessage,
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: res.toolUseId,
              status: 'error',
              content: [
                { text: `Your input failed validation — ${problem}. Re-emit valid ${spec.toolName} input.` },
              ],
            },
          },
        ],
      },
    ];
  }

  // Fallback: no tool call to anchor a toolResult (truncation or a refusal). Rebuild the same
  // first-turn shape — cached prefix + checkpoint included — with the correction appended, so a
  // Score retry keeps the résumé (and its warm cache) and the request stays well-formed.
  const nudged = `${spec.userText}\n\nYour previous response was invalid — ${problem}. Call ${spec.toolName} with input matching the schema.`;
  return [userTurn(spec, nudged)];
}

function previewJson(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const text = serialized ?? String(value); // JSON.stringify(undefined) === undefined
  return text.length > RAW_INPUT_LOG_CAP
    ? `${text.slice(0, RAW_INPUT_LOG_CAP)}…[+${text.length - RAW_INPUT_LOG_CAP} chars]`
    : text;
}
