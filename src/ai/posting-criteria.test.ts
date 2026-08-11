import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostingCriteriaSchema, extractCriteria } from './posting-criteria';

const bedrockMock = mockClient(BedrockRuntimeClient);

function toolReply(input: unknown): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't1', name: 'emit_criteria', input } }],
      },
    },
  } as unknown as ConverseCommandOutput;
}

const validCriteria = {
  must_haves: ['5+ years backend engineering'],
  nice_to_haves: ['AWS experience'],
  dealbreakers: ['must be on-site in NYC'],
};

describe('PostingCriteriaSchema', () => {
  it('accepts well-formed criteria', () => {
    expect(PostingCriteriaSchema.safeParse(validCriteria).success).toBe(true);
  });

  it('rejects criteria missing a bucket', () => {
    const { dealbreakers, ...rest } = validCriteria;
    expect(PostingCriteriaSchema.safeParse(rest).success).toBe(false);
  });
});

describe('extractCriteria', () => {
  beforeEach(() => bedrockMock.reset());
  afterEach(() => vi.unstubAllEnvs());

  it('returns validated criteria from a forced tool-use response', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply(validCriteria));

    const result = await extractCriteria('job description text');

    expect(result).toEqual(validCriteria);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(1);
  });

  it('retries once when the first response fails validation, then succeeds', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(toolReply({ must_haves: [] }))
      .resolves(toolReply(validCriteria));

    const result = await extractCriteria('job description text');

    expect(result).toEqual(validCriteria);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('throws after the retry still fails validation', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply({ nope: true }));

    await expect(extractCriteria('job description text')).rejects.toThrow(/schema validation/);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(3);
  });

  it('bills to the fast model when one is configured (extraction-class call)', async () => {
    // Env is read at module load, so stub first and import a fresh copy (s3.test.ts idiom).
    vi.resetModules();
    vi.stubEnv('BEDROCK_MODEL_ID', 'standard-model');
    vi.stubEnv('BEDROCK_FAST_MODEL_ID', 'fast-model');
    bedrockMock.on(ConverseCommand).resolves(toolReply(validCriteria));

    const fresh = (await import('./posting-criteria')).extractCriteria;
    await fresh('job description text');

    expect(bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.modelId).toBe('fast-model');
  });
});
