import { extractCriteria } from '../ai/posting-criteria';
import { getPosting, saveCriteria } from '../data/run';
import { logger } from '../shared/logger';

interface ExtractCriteriaEvent {
  userId: string;
  runId: string;
  postingId: string;
}

// Step Functions task: JD text → structured screening criteria, persisted on the posting.
// Throws on a missing posting or an unparseable model response; Step Functions catches it
// and routes the run to SetError.
export async function handler(event: ExtractCriteriaEvent): Promise<void> {
  const posting = await getPosting(event.runId, event.postingId);
  if (!posting) {
    throw new Error(`posting ${event.postingId} not found for run ${event.runId}`);
  }

  const criteria = await extractCriteria(posting.description);
  await saveCriteria(event.runId, event.postingId, criteria);

  logger.info('extracted posting criteria', {
    runId: event.runId,
    postingId: event.postingId,
    mustHaves: criteria.must_haves.length,
    niceToHaves: criteria.nice_to_haves.length,
    dealbreakers: criteria.dealbreakers.length,
  });
}
