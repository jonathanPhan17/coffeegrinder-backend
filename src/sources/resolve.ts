import { logger } from '../shared/logger';
import type { PastedPosting } from './pasted';

/**
 * Which source a run uses (§6), decided once from the request body instead of scattered
 * `if (postings)` branches. Inference, not an explicit flag: pasted JDs in the body → the
 * synchronous PastedSource; otherwise → ApifySource, fetched asynchronously by the state
 * machine. The empty-postings case never reaches here — createRunSchema requires `.min(1)`.
 */
export type ResolvedSource =
  | { kind: 'pasted'; postings: PastedPosting[] }
  | { kind: 'apify' };

export function resolveSource(body: { postings?: PastedPosting[] }): ResolvedSource {
  if (body.postings?.length) {
    logger.info('run source resolved', { source: 'pasted', postings: body.postings.length });
    return { kind: 'pasted', postings: body.postings };
  }
  logger.info('run source resolved', { source: 'apify' });
  return { kind: 'apify' };
}
