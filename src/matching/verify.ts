import type { CriterionEvidence } from '../types/domain';
import type { ScoredCriterion } from '../ai/score-match';

// Core of Verify: fold both the quote and the résumé to the same canonical form before
// matching, so honest quotes are not flagged as fabricated over pdf-parse whitespace or
// the model's smart quotes/dashes. Lowercase, ASCII-fold quotes/dashes, collapse whitespace.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deterministic evidence verification (§5). A met/partial verdict must be backed by a
// quote that actually appears in the résumé; a fabricated (or empty) quote is downgraded
// to not_met with its snippet cleared. Returns the verified criteria plus the fraction of
// quoted (met/partial) criteria that failed — the caller retries the whole Score if it's high.
export function verifyEvidence(
  scored: ScoredCriterion[],
  resumeText: string,
): { verified: Omit<CriterionEvidence, 'id'>[]; fabricatedFraction: number } {
  const haystack = normalize(resumeText);
  let quotedCount = 0;
  let fabricated = 0;

  const verified = scored.map((c): Omit<CriterionEvidence, 'id'> => {
    // not_met carries no snippet (frontend contract) and needs no quote.
    if (c.verdict === 'not_met') {
      return {
        group: c.group,
        criterion: c.criterion,
        verdict: 'not_met',
        confidence: c.confidence,
        reasoning: c.reasoning,
      };
    }

    // met / partial must be grounded in a real résumé quote.
    quotedCount += 1;
    const needle = normalize(c.quote);
    const grounded = needle.length > 0 && haystack.includes(needle);
    if (grounded) {
      return {
        group: c.group,
        criterion: c.criterion,
        verdict: c.verdict,
        confidence: c.confidence,
        snippet: c.quote,
        reasoning: c.reasoning,
      };
    }

    fabricated += 1;
    return {
      group: c.group,
      criterion: c.criterion,
      verdict: 'not_met',
      confidence: c.confidence,
      reasoning: c.reasoning,
    };
  });

  return { verified, fabricatedFraction: quotedCount > 0 ? fabricated / quotedCount : 0 };
}
