import { putPosting, reconcileRunCount } from '../data/run';
import { getDatasetItems } from '../shared/apify';
import { APIFY_TOKEN_PARAM } from '../shared/env';
import { logger } from '../shared/logger';
import { getSecureParam } from '../shared/ssm';
import { normalizeIndeedItems } from '../sources/apify';
import type { ActorState } from './start-actor-run';

interface CollectPostingsEvent {
  userId: string;
  runId: string;
  actor: ActorState;
}

/**
 * Step Functions Fetch stage, final step (SUCCEEDED branch): pull the dataset, normalize +
 * validate the rows, persist them, and reconcile run.count to how many actually came back.
 * Returns the postingIds the Map fans out over. A malformed dataset (actor schema drift) throws
 * out of normalizeIndeedItems → the machine catches it to SetError; individual partial rows are
 * dropped inside normalize, not fatal. A zero-row result is a valid "no jobs found" outcome:
 * count reconciles to 0 and the empty Map falls straight through to done.
 */
export async function handler(event: CollectPostingsEvent): Promise<string[]> {
  const token = await getSecureParam(APIFY_TOKEN_PARAM);
  const items = await getDatasetItems(event.actor.datasetId, token);
  const postings = normalizeIndeedItems(items);

  await Promise.all(postings.map((posting) => putPosting(event.runId, posting)));
  await reconcileRunCount(event.userId, event.runId, postings.length);

  logger.info('collected Apify postings', {
    runId: event.runId,
    datasetId: event.actor.datasetId,
    count: postings.length,
  });
  return postings.map((posting) => posting.sourceId);
}
