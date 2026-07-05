import { z } from 'zod';
import { logger } from '../shared/logger';
import type { JobPosting } from '../types/domain';

// ApifySource — the real fetched-jobs source (§6), backed by the misceres/indeed-scraper
// actor. Unlike PastedSource it is not a synchronous JobSource.fetch(): an Apify run takes
// minutes, so the fetch is split across the state machine's Fetch stage (start → poll →
// collect). This module owns the two ends the machine touches: the actor INPUT it starts with,
// and the OUTPUT normalization/validation when the run finishes.

// misceres/indeed-scraper input (only the fields we set). `maxItemsPerSearch` is the cost cap
// — it bounds both the scrape spend and the downstream Bedrock fan-out.
export function buildIndeedInput(input: {
  query: string;
  location?: string;
  limit: number;
}): Record<string, unknown> {
  return {
    position: input.query,
    location: input.location,
    maxItemsPerSearch: input.limit,
    country: 'US',
    saveOnlyUniqueItems: true,
  };
}

// One scraped row we can actually screen. The required fields are exactly what ExtractCriteria
// and Score depend on; `url` is Indeed's always-present posting link (NOT externalApplyLink,
// which needs followApplyRedirects and is often absent). A row missing any required field is an
// expected partial scrape result — dropped, not fatal (see normalizeIndeedItems).
const indeedRowSchema = z.object({
  id: z.string().min(1),
  positionName: z.string().min(1),
  company: z.string().min(1),
  description: z.string().min(1),
  url: z.string().min(1),
  location: z.string().optional(),
});

// The dataset as a whole must be an array of rows. A non-array (an error envelope, or the actor
// changing its output contract) is NOT a bad row — it is a run-level failure. Kept deliberately
// separate from the per-row check so the two trust-boundary failures get two responses:
// bad row → drop + log; bad dataset → throw → run status `error`.
const datasetSchema = z.array(z.unknown());

export function normalizeIndeedItems(items: unknown): JobPosting[] {
  const rows = datasetSchema.parse(items); // throws → run-level error (actor schema drift)

  const postings: JobPosting[] = [];
  let dropped = 0;
  for (const row of rows) {
    const parsed = indeedRowSchema.safeParse(row);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const r = parsed.data;
    postings.push({
      sourceId: r.id, // Indeed's stable job id — reused across runs (sets up dedup later)
      source: 'apify',
      title: r.positionName,
      company: r.company,
      location: r.location,
      description: r.description,
      applyUrl: r.url,
    });
  }

  if (dropped > 0) {
    logger.warn('dropped incomplete Apify rows', {
      event: 'apify_row_dropped',
      dropped,
      kept: postings.length,
    });
  }
  return postings;
}
