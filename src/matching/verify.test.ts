import { describe, expect, it } from 'vitest';
import type { ScoredCriterion } from '../ai/score-match';
import { normalize, verifyEvidence } from './verify';

const resume =
  'Built React 18 apps across a 6-month internship. Wrote unit tests for core components.';

function crit(over: Partial<ScoredCriterion>): ScoredCriterion {
  return {
    criterion: 'x',
    group: 'must_have',
    verdict: 'met',
    confidence: 0.8,
    quote: '',
    reasoning: 'r',
    ...over,
  };
}

describe('normalize', () => {
  it('lowercases, collapses whitespace, and ASCII-folds quotes and dashes', () => {
    expect(normalize('React 18   Apps')).toBe('react 18 apps');
    expect(normalize('don’t')).toBe("don't");
    expect(normalize('full—stack')).toBe('full-stack');
    expect(normalize('  padded\nline  ')).toBe('padded line');
  });
});

describe('verifyEvidence', () => {
  it('keeps a met verdict whose quote appears despite whitespace/case differences', () => {
    const { verified, fabricatedFraction } = verifyEvidence(
      [crit({ verdict: 'met', quote: 'React 18   APPS across a 6-month internship' })],
      resume,
    );
    expect(verified[0].verdict).toBe('met');
    expect(verified[0].snippet).toBeTruthy();
    expect(fabricatedFraction).toBe(0);
  });

  it('downgrades a fabricated quote to not_met and clears its snippet', () => {
    const { verified, fabricatedFraction } = verifyEvidence(
      [crit({ verdict: 'met', quote: 'Led a team of 40 engineers at Google' })],
      resume,
    );
    expect(verified[0].verdict).toBe('not_met');
    expect(verified[0].snippet).toBeUndefined();
    expect(fabricatedFraction).toBe(1);
  });

  it('downgrades a met verdict with an empty quote', () => {
    const { verified } = verifyEvidence([crit({ verdict: 'met', quote: '' })], resume);
    expect(verified[0].verdict).toBe('not_met');
  });

  it('leaves not_met untouched with no snippet and does not count it as quoted', () => {
    const { verified, fabricatedFraction } = verifyEvidence(
      [crit({ verdict: 'not_met', quote: '' })],
      resume,
    );
    expect(verified[0].verdict).toBe('not_met');
    expect(verified[0].snippet).toBeUndefined();
    expect(fabricatedFraction).toBe(0);
  });

  it('reports the fabricated fraction over quoted criteria only', () => {
    const { fabricatedFraction } = verifyEvidence(
      [
        crit({ verdict: 'met', quote: 'React 18' }), // grounded
        crit({ verdict: 'met', quote: 'nonexistent claim one' }), // fabricated
        crit({ verdict: 'partial', quote: 'nonexistent claim two' }), // fabricated
        crit({ verdict: 'not_met', quote: '' }), // not quoted
      ],
      resume,
    );
    expect(fabricatedFraction).toBeCloseTo(2 / 3);
  });
});
