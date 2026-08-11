import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scoreMatch } from './score-match';

const bedrockMock = mockClient(BedrockRuntimeClient);

function scorecardReply(input: unknown, stopReason = 'tool_use'): ConverseCommandOutput {
  return {
    $metadata: {},
    stopReason,
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't1', name: 'emit_scorecard', input } }],
      },
    },
  } as unknown as ConverseCommandOutput;
}

const validScorecard = {
  criteria: [
    {
      criterion: 'React proficiency',
      group: 'must_have',
      verdict: 'met',
      confidence: 0.9,
      quote: 'Built React apps',
      reasoning: 'Clear React experience.',
    },
  ],
  summary: 'Strong fit.',
};

const criteria = { must_haves: ['React proficiency'], nice_to_haves: [], dealbreakers: [] };

describe('scoreMatch', () => {
  beforeEach(() => bedrockMock.reset());
  afterEach(() => vi.unstubAllEnvs());

  it('returns the validated scorecard', async () => {
    bedrockMock.on(ConverseCommand).resolves(scorecardReply(validScorecard));

    const result = await scoreMatch('resume', criteria);

    expect(result.summary).toBe('Strong fit.');
    expect(result.criteria[0].verdict).toBe('met');
  });

  it('treats a max_tokens truncation as a failed attempt and retries', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(scorecardReply(validScorecard, 'max_tokens'))
      .resolves(scorecardReply(validScorecard));

    const result = await scoreMatch('resume', criteria);

    expect(result.summary).toBe('Strong fit.');
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('throws after the retry still fails validation', async () => {
    bedrockMock.on(ConverseCommand).resolves(scorecardReply({ bogus: true }));

    await expect(scoreMatch('resume', criteria)).rejects.toThrow(/schema validation/);
  });

  it('stays on the standard model even when a fast model is configured', async () => {
    // Scoring is the quality-sensitive call — moving it to the cheap tier is a deliberate,
    // benchmark-backed decision (scripts/scoring-benchmark.ts), never a config side effect.
    vi.resetModules();
    vi.stubEnv('BEDROCK_MODEL_ID', 'standard-model');
    vi.stubEnv('BEDROCK_FAST_MODEL_ID', 'fast-model');
    bedrockMock.on(ConverseCommand).resolves(scorecardReply(validScorecard));

    const fresh = (await import('./score-match')).scoreMatch;
    await fresh('resume', criteria);

    expect(bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.modelId).toBe('standard-model');
  });
});
