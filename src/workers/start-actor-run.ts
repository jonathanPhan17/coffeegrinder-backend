import { saveApifyRunId } from '../data/run';
import { startActorRun } from '../shared/apify';
import { APIFY_ACTOR_ID, APIFY_TOKEN_PARAM } from '../shared/env';
import { logger } from '../shared/logger';
import { getSecureParam } from '../shared/ssm';
import { buildIndeedInput } from '../sources/apify';

interface StartActorRunEvent {
  userId: string;
  runId: string;
  query: string;
  location?: string;
  limit: number;
}

// The state carried through the poll loop. `attempts` starts at 0 and GetActorStatus bumps it;
// the machine's guard trips to SetError once it reaches the ceiling, so a stuck run can't hang.
export interface ActorState {
  apifyRunId: string;
  datasetId: string;
  attempts: number;
  status?: string;
}

// Step Functions Fetch stage, step 1: start the Apify actor run and return its handle. This
// state is deliberately NOT retried by the machine (retryOnServiceExceptions: false) — a
// retried start would pay for a second actor run. We persist the run id the instant we have it
// so even a lost response is traceable to the run that was actually charged.
export async function handler(event: StartActorRunEvent): Promise<ActorState> {
  const token = await getSecureParam(APIFY_TOKEN_PARAM);
  const input = buildIndeedInput({
    query: event.query,
    location: event.location,
    limit: event.limit,
  });

  const run = await startActorRun(APIFY_ACTOR_ID, input, token);
  await saveApifyRunId(event.userId, event.runId, run.apifyRunId);

  logger.info('started Apify actor run', {
    runId: event.runId,
    apifyRunId: run.apifyRunId,
    datasetId: run.datasetId,
    limit: event.limit,
  });
  return { apifyRunId: run.apifyRunId, datasetId: run.datasetId, attempts: 0 };
}
