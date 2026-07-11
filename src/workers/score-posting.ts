import { scoreMatch } from '../ai/score-match';
import { putMatch } from '../data/match';
import { getResumeText } from '../data/resume-profile';
import { getPostingWithCriteria } from '../data/run';
import { computeScore, scoreToFitTier } from '../matching/score';
import { verifyEvidence } from '../matching/verify';
import { logger } from '../shared/logger';
import type { CriterionEvidence, Match } from '../types/domain';

interface ScorePostingEvent {
  userId: string;
  runId: string;
  postingId: string;
}

const MAX_FABRICATED_FRACTION = 1 / 3;

/**
 * Step Functions task: grounded Score → deterministic Verify → code-computed score →
 * persist the Match. Throws on missing inputs; Step Functions catches it to SetError.
 */
export async function handler(event: ScorePostingEvent): Promise<void> {
  const [inputs, resumeText] = await Promise.all([
    getPostingWithCriteria(event.runId, event.postingId),
    getResumeText(event.userId),
  ]);
  if (!inputs) {
    throw new Error(`posting ${event.postingId} (with criteria) not found for run ${event.runId}`);
  }
  if (!resumeText) {
    throw new Error(`no parsed résumé for user ${event.userId}`);
  }
  const { posting, criteria } = inputs;

  let result = await scoreMatch(resumeText, criteria);
  let checked = verifyEvidence(result.criteria, resumeText);
  // Too many fabricated quotes → one full re-score, then accept whatever verifies.
  if (checked.fabricatedFraction > MAX_FABRICATED_FRACTION) {
    logger.warn('many fabricated quotes; re-scoring once', {
      postingId: event.postingId,
      fabricatedFraction: checked.fabricatedFraction,
    });
    result = await scoreMatch(resumeText, criteria);
    checked = verifyEvidence(result.criteria, resumeText);
  }

  const evidence: CriterionEvidence[] = checked.verified.map((c, i) => ({ id: `c${i + 1}`, ...c }));
  const score = computeScore(checked.verified);
  const match: Match = {
    id: event.postingId,
    runId: event.runId,
    posting,
    score,
    fitTier: scoreToFitTier(score),
    summary: result.summary,
    evidence,
    status: 'matched',
  };
  await putMatch(event.userId, event.runId, match);

  logger.info('scored match', {
    postingId: event.postingId,
    score,
    fitTier: match.fitTier,
    criteria: evidence.length,
  });
}
