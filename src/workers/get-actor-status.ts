import { getActorRunStatus } from '../shared/apify';
import { APIFY_TOKEN_PARAM } from '../shared/env';
import { logger } from '../shared/logger';
import { getSecureParam } from '../shared/ssm';
import type { ActorState } from './start-actor-run';

interface GetActorStatusEvent {
  runId: string;
  actor: ActorState;
}

// Step Functions Fetch stage, poll step: one status check, called on each loop pass after a
// Wait. Returns the refreshed actor state (with attempts incremented) back to $.actor; the
// machine's ActorDone Choice routes on `status` and enforces the attempts ceiling.
export async function handler(event: GetActorStatusEvent): Promise<ActorState> {
  const token = await getSecureParam(APIFY_TOKEN_PARAM);
  const { status, datasetId } = await getActorRunStatus(event.actor.apifyRunId, token);

  const attempts = event.actor.attempts + 1;
  logger.info('polled Apify actor run', {
    runId: event.runId,
    apifyRunId: event.actor.apifyRunId,
    status,
    attempts,
  });
  return {
    apifyRunId: event.actor.apifyRunId,
    datasetId: datasetId || event.actor.datasetId,
    attempts,
    status,
  };
}
