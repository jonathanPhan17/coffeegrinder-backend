import { randomUUID } from 'node:crypto';
import type { JobPosting } from '../types/domain';
import type { JobSource, JobSourceInput } from './job-source';

/** Raw posting a user pastes in; the matcher only ever sees the normalized JobPosting. */
export interface PastedPosting {
  title: string;
  company: string;
  applyUrl: string;
  description: string;
  location?: string;
  remote?: boolean;
}

/**
 * Free, zero-risk source for MVP + local dev: normalizes pasted JD text into the
 * standard JobPosting shape (§6). ApifySource will implement the same interface later.
 */
export class PastedSource implements JobSource {
  constructor(private readonly postings: PastedPosting[]) {}

  async fetch(input: JobSourceInput): Promise<JobPosting[]> {
    return this.postings.slice(0, input.limit).map((p) => ({
      sourceId: randomUUID(),
      source: 'pasted',
      title: p.title,
      company: p.company,
      location: p.location,
      remote: p.remote,
      description: p.description,
      applyUrl: p.applyUrl,
    }));
  }
}
