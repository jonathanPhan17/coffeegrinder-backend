import type { CriterionGroup, FitTier, Verdict } from '../types/domain';

// The score is computed in code from the VERIFIED verdicts (never emitted by the LLM), so
// the number can never disagree with the evidence table it sits on. Applied after Verify.
const WEIGHT: Record<'must_have' | 'nice_to_have', number> = { must_have: 1, nice_to_have: 0.5 };
const CREDIT: Record<Verdict, number> = { met: 1, partial: 0.5, not_met: 0 };
const DEALBREAKER_CAP = 25;
// A dealbreaker caps the score only when the model is confident it is genuinely violated.
// Dealbreakers are phrased as requirements (met = satisfied), so a violation is not_met; but
// résumés rarely address sponsorship/authorization, and a low-confidence not_met there is
// "unknown", not a violation — it must not tank an otherwise-good match.
const DEALBREAKER_CONFIDENCE = 0.7;

export function computeScore(
  criteria: readonly { group: CriterionGroup; verdict: Verdict; confidence: number }[],
): number {
  let totalWeight = 0;
  let earned = 0;
  for (const c of criteria) {
    if (c.group === 'dealbreaker') continue; // dealbreakers cap, they don't weigh
    const weight = WEIGHT[c.group];
    totalWeight += weight;
    earned += weight * CREDIT[c.verdict];
  }

  const base = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
  const dealbreakerTriggered = criteria.some(
    (c) =>
      c.group === 'dealbreaker' &&
      c.verdict === 'not_met' &&
      c.confidence >= DEALBREAKER_CONFIDENCE,
  );
  return dealbreakerTriggered ? Math.min(base, DEALBREAKER_CAP) : base;
}

// Thresholds match the shipped frontend mock data (src/mocks/fixtures.ts), so tiers never
// shift when MOCK flips off.
export function scoreToFitTier(score: number): FitTier {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'good';
  if (score >= 55) return 'fair';
  return 'weak';
}
