import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StructuredProfileSchema, structureResume } from './resume-structure';

const bedrockMock = mockClient(BedrockRuntimeClient);

function toolReply(input: unknown): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't1', name: 'emit_profile', input } }],
      },
    },
  } as unknown as ConverseCommandOutput;
}

function textReply(text: string): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content: [{ text }] } },
  } as unknown as ConverseCommandOutput;
}

const validProfile = {
  targetRole: 'Senior Backend Engineer',
  experience: 'Eight years building distributed services on AWS.',
  education: 'BSc Computer Science, State University.',
  skills: ['TypeScript', 'AWS', 'DynamoDB'],
};

describe('StructuredProfileSchema', () => {
  it('accepts a well-formed profile', () => {
    expect(StructuredProfileSchema.safeParse(validProfile).success).toBe(true);
  });

  it('rejects a profile missing skills', () => {
    const { skills, ...rest } = validProfile;
    expect(StructuredProfileSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects skills of the wrong type', () => {
    expect(
      StructuredProfileSchema.safeParse({ ...validProfile, skills: 'TypeScript' }).success,
    ).toBe(false);
  });
});

describe('structureResume', () => {
  beforeEach(() => bedrockMock.reset());
  afterEach(() => vi.unstubAllEnvs());

  it('returns the validated profile from a forced tool-use response', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply(validProfile));

    const result = await structureResume('raw resume text');

    expect(result).toEqual(validProfile);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(1);
  });

  it('retries once when the first response fails validation, then succeeds', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(toolReply({ targetRole: 'x' }))
      .resolves(toolReply(validProfile));

    const result = await structureResume('raw resume text');

    expect(result).toEqual(validProfile);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('retries when the response carries no tool-use block', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(textReply('I could not comply'))
      .resolves(toolReply(validProfile));

    const result = await structureResume('raw resume text');

    expect(result).toEqual(validProfile);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('throws after the retry still fails validation', async () => {
    bedrockMock.on(ConverseCommand).resolves(toolReply({ not: 'a profile' }));

    await expect(structureResume('raw resume text')).rejects.toThrow(/schema validation/);
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(3);
  });

  it('bills to the fast model when one is configured (extraction-class call)', async () => {
    // Env is read at module load, so stub first and import a fresh copy (s3.test.ts idiom).
    vi.resetModules();
    vi.stubEnv('BEDROCK_MODEL_ID', 'standard-model');
    vi.stubEnv('BEDROCK_FAST_MODEL_ID', 'fast-model');
    bedrockMock.on(ConverseCommand).resolves(toolReply(validProfile));

    const fresh = (await import('./resume-structure')).structureResume;
    await fresh('raw resume text');

    expect(bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.modelId).toBe('fast-model');
  });
});
