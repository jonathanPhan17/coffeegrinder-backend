import { describe, expect, it } from 'vitest';
import type { CriterionGroup, Verdict } from '../types/domain';
import { computeScore, scoreToFitTier } from './score';

const c = (group: CriterionGroup, verdict: Verdict) => ({ group, verdict });

describe('computeScore', () => {
  it('is 100 when every weighted criterion is met', () => {
    expect(computeScore([c('must_have', 'met'), c('nice_to_have', 'met')])).toBe(100);
  });

  it('credits partial at half and weights nice-to-haves at half', () => {
    // must met (1×1) + nice partial (0.5×0.5=0.25) = 1.25 / 1.5 = 83
    expect(computeScore([c('must_have', 'met'), c('nice_to_have', 'partial')])).toBe(83);
  });

  it('gives no credit for not_met', () => {
    expect(computeScore([c('must_have', 'met'), c('must_have', 'not_met')])).toBe(50);
  });

  it('caps the score at 25 when a dealbreaker is not_met (triggered)', () => {
    expect(
      computeScore([c('must_have', 'met'), c('nice_to_have', 'met'), c('dealbreaker', 'not_met')]),
    ).toBe(25);
  });

  it('does NOT cap when a dealbreaker is met (satisfied / not triggered)', () => {
    expect(
      computeScore([c('must_have', 'met'), c('nice_to_have', 'met'), c('dealbreaker', 'met')]),
    ).toBe(100);
  });

  it('excludes dealbreakers from the weighted average', () => {
    // only the must-have weighs; the met dealbreaker neither adds weight nor caps
    expect(computeScore([c('must_have', 'met'), c('dealbreaker', 'met')])).toBe(100);
  });

  it('is 0 when there are no weighted criteria', () => {
    expect(computeScore([c('dealbreaker', 'met')])).toBe(0);
  });
});

describe('scoreToFitTier', () => {
  it('matches the frontend mock score→tier pairs exactly', () => {
    expect(scoreToFitTier(94)).toBe('strong');
    expect(scoreToFitTier(88)).toBe('strong');
    expect(scoreToFitTier(81)).toBe('good');
    expect(scoreToFitTier(73)).toBe('good');
    expect(scoreToFitTier(66)).toBe('fair');
    expect(scoreToFitTier(52)).toBe('weak');
  });

  it('honors the 85 / 70 / 55 boundaries', () => {
    expect(scoreToFitTier(85)).toBe('strong');
    expect(scoreToFitTier(84)).toBe('good');
    expect(scoreToFitTier(70)).toBe('good');
    expect(scoreToFitTier(69)).toBe('fair');
    expect(scoreToFitTier(55)).toBe('fair');
    expect(scoreToFitTier(54)).toBe('weak');
  });
});
