import type { JobPosting } from '../types/domain';

/**
 * Every source produces the same normalized JobPosting; the matcher never knows where
 * a posting came from (§6). PastedSource is the free MVP/dev implementation; ApifySource
 * implements the same interface in V2.
 */
export interface JobSourceInput {
  query: string;
  location?: string;
  limit: number;
}

export interface JobSource {
  fetch(input: JobSourceInput): Promise<JobPosting[]>;
}
