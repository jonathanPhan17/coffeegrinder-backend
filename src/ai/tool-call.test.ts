import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { logger } from '../shared/logger';
import { type ToolCallSpec, callTool } from './tool-call';

const bedrockMock = mockClient(BedrockRuntimeClient);

const schema = z.object({ ok: z.boolean() });

const spec: ToolCallSpec = {
  toolName: 'emit_thing',
  toolDescription: 'emit a thing',
  inputSchema: { json: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
  systemPrompt: 'system',
  userText: 'do the thing',
  label: 'thing',
};

function toolReply(
  input: unknown,
  opts: { toolUseId?: string; stopReason?: string } = {},
): ConverseCommandOutput {
  return {
    $metadata: {},
    stopReason: opts.stopReason ?? 'tool_use',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: opts.toolUseId ?? 't1', name: 'emit_thing', input } }],
      },
    },
  } as unknown as ConverseCommandOutput;
}

function textReply(text: string, stopReason = 'end_turn'): ConverseCommandOutput {
  return {
    $metadata: {},
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    output: { message: { role: 'assistant', content: [{ text }] } },
  } as unknown as ConverseCommandOutput;
}

describe('callTool', () => {
  beforeEach(() => bedrockMock.reset());

  it('feeds the validation error back as a toolResult turn, then returns the repaired result', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(toolReply({ ok: 'nope' }, { toolUseId: 'call-1' })) // invalid: ok is a string
      .resolves(toolReply({ ok: true }, { toolUseId: 'call-2' }));

    const result = await callTool(schema, spec);
    expect(result).toEqual({ ok: true });

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls).toHaveLength(2);

    // The correction request continues the conversation: the model's own tool-use turn,
    // followed by an error toolResult that references that exact tool call.
    const retryMessages = calls[1].args[0].input.messages ?? [];
    expect(
      retryMessages.some((m) => m.role === 'assistant' && (m.content ?? []).some((b) => b.toolUse)),
    ).toBe(true);
    const toolResult = retryMessages.flatMap((m) => m.content ?? []).find((b) => b.toolResult)?.toolResult;
    expect(toolResult?.toolUseId).toBe('call-1');
    expect(toolResult?.status).toBe('error');
  });

  it('throws after the original call plus two retries still fail validation', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: 'nope' }));

    await expect(callTool(schema, spec)).rejects.toThrow(/schema validation/);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(3);
  });

  it('places a cachePoint after the cachePrefix when one is given', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: true }));

    await callTool(schema, { ...spec, cachePrefix: 'STABLE PREFIX' });

    const content = bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.messages?.[0].content;
    expect(content).toEqual([
      { text: 'STABLE PREFIX' },
      { cachePoint: { type: 'default' } },
      { text: spec.userText },
    ]);
  });

  it('sends a single text block (no cachePoint) when no cachePrefix is given', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: true }));

    await callTool(schema, spec);

    const content = bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.messages?.[0].content ?? [];
    expect(content).toEqual([{ text: spec.userText }]);
    expect(content.some((b) => b.cachePoint)).toBe(false);
  });

  it('preserves the cached first user turn byte-for-byte across a correction retry', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(toolReply({ ok: 'nope' }, { toolUseId: 'call-1' }))
      .resolves(toolReply({ ok: true }));

    await callTool(schema, { ...spec, cachePrefix: 'RESUME PREFIX' });

    const calls = bedrockMock.commandCalls(ConverseCommand);
    const firstTurnBefore = calls[0].args[0].input.messages?.[0];
    const firstTurnAfter = calls[1].args[0].input.messages?.[0];
    // The prefix + cachePoint must survive into the retry unchanged, or it stops reading the
    // warm cache — this guards that property against a future withCorrection refactor.
    expect(firstTurnAfter).toEqual(firstTurnBefore);
    expect(firstTurnAfter?.content).toEqual([
      { text: 'RESUME PREFIX' },
      { cachePoint: { type: 'default' } },
      { text: spec.userText },
    ]);
  });

  it('falls back to a fresh re-prompt when the reply has no tool call to anchor a toolResult', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(textReply('...', 'max_tokens')) // no toolUse — cannot attach a toolResult
      .resolves(toolReply({ ok: true }));

    const result = await callTool(schema, spec);
    expect(result).toEqual({ ok: true });

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls).toHaveLength(2);
    // Fallback keeps the request well-formed: a single user turn, no dangling toolResult.
    const retryMessages = calls[1].args[0].input.messages ?? [];
    expect(retryMessages.flatMap((m) => m.content ?? []).some((b) => b.toolResult)).toBe(false);
    expect(retryMessages.every((m) => m.role === 'user')).toBe(true);
  });

  it('keeps the cachePrefix + cachePoint on the fallback retry, with the nudge after the checkpoint', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(textReply('...', 'max_tokens')) // no toolUse → fallback path
      .resolves(toolReply({ ok: true }));

    await callTool(schema, { ...spec, cachePrefix: 'RESUME PREFIX' });

    const retryContent = bedrockMock.commandCalls(ConverseCommand)[1].args[0].input.messages?.[0].content ?? [];
    // prefix + checkpoint intact so a truncated/refused Score retry keeps the résumé and reads
    // the warm cache; the correction nudge lands in the text block after the checkpoint.
    expect(retryContent[0]).toEqual({ text: 'RESUME PREFIX' });
    expect(retryContent[1]).toEqual({ cachePoint: { type: 'default' } });
    expect(retryContent[2]?.text).toContain(spec.userText);
    expect(retryContent[2]?.text).toContain(`Call ${spec.toolName} with input matching the schema`);
  });

  it('logs token usage with the model id on success even without a cachePrefix', async () => {
    // The success-path log is the raw feed for per-user spend metering — a call site that
    // stays silent (as uncached calls did before the tier split) is a metering hole.
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: true }));

    await callTool(schema, spec);

    expect(info).toHaveBeenCalledWith(
      'thing tokens',
      expect.objectContaining({
        label: 'thing',
        modelId: expect.any(String) as string,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }),
    );
    info.mockRestore();
  });
});

// Tier → model-id resolution reads env at module load (the shared env.ts contract), so each
// test stubs env first and imports a fresh copy of the module. The Bedrock mock survives the
// re-import: aws-sdk-client-mock stubs the client class itself, which vitest does not reset.
describe('model tier routing', () => {
  beforeEach(() => {
    bedrockMock.reset();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  const freshCallTool = async (): Promise<typeof callTool> => (await import('./tool-call')).callTool;

  it('bills a fast-tier call to BEDROCK_FAST_MODEL_ID when it is set', async () => {
    vi.stubEnv('BEDROCK_MODEL_ID', 'standard-model');
    vi.stubEnv('BEDROCK_FAST_MODEL_ID', 'fast-model');
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: true }));

    await (await freshCallTool())(schema, { ...spec, tier: 'fast' });

    expect(bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.modelId).toBe('fast-model');
  });

  it('falls back to the standard model when no fast model is configured', async () => {
    vi.stubEnv('BEDROCK_MODEL_ID', 'standard-model');
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: true }));

    await (await freshCallTool())(schema, { ...spec, tier: 'fast' });

    expect(bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.modelId).toBe('standard-model');
  });

  it('keeps default-tier calls on the standard model even when a fast id exists', async () => {
    vi.stubEnv('BEDROCK_MODEL_ID', 'standard-model');
    vi.stubEnv('BEDROCK_FAST_MODEL_ID', 'fast-model');
    bedrockMock.on(ConverseCommand).resolves(toolReply({ ok: true }));

    await (await freshCallTool())(schema, spec);

    expect(bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.modelId).toBe('standard-model');
  });
});
