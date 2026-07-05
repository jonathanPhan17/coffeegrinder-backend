// Mirror of coffeegrinder-frontend/src/types/domain.ts — the §8 API contract the
// backend must satisfy. Kept in sync manually (no shared package across repos).

/* ── Job postings (§6) ───────────────────────────────────────────────── */

export type JobSourceKind = 'apify' | 'pasted';

export interface Salary {
  min?: number;
  max?: number;
  currency?: string;
  interval?: 'year' | 'month' | 'hour';
}

export interface JobPosting {
  sourceId: string;
  source: JobSourceKind;
  title: string;
  company: string;
  location?: string;
  remote?: boolean;
  description: string;
  applyUrl: string;
  salary?: Salary;
  postedAt?: string;
}

/* ── Runs (§4, §7) ───────────────────────────────────────────────────── */

export type RunStatus = 'queued' | 'fetching' | 'screening' | 'done' | 'error';

export interface Run {
  id: string;
  status: RunStatus;
  count: number;
  query: string;
  location?: string;
  remote?: boolean;
  screened?: number;
  /** Postings whose scoring chain failed and was skipped (state machine ADDs this). */
  failed?: number;
  createdAt: string;
}

/* ── Matches & scorecards (§5) ───────────────────────────────────────── */

export type Verdict = 'met' | 'partial' | 'not_met';
export type CriterionGroup = 'must_have' | 'nice_to_have' | 'dealbreaker';
export type FitTier = 'strong' | 'good' | 'fair' | 'weak';

export interface CriterionEvidence {
  id: string;
  group: CriterionGroup;
  criterion: string;
  verdict: Verdict;
  confidence: number;
  snippet?: string;
  reasoning: string;
}

export type PipelineStatus =
  | 'matched'
  | 'shortlisted'
  | 'applied'
  | 'interviewing'
  | 'offer'
  | 'rejected';

export interface Match {
  id: string;
  runId: string;
  posting: JobPosting;
  score: number;
  fitTier: FitTier;
  summary: string;
  evidence: CriterionEvidence[];
  status: PipelineStatus;
}

/* ── Cover letters (§7: LETTER#<version>) ────────────────────────────── */

export type CoverLetterTone = 'friendly' | 'formal';

export interface CoverLetterDraft {
  version: number;
  tone: CoverLetterTone;
  body: string;
  createdAt: string;
}

/* ── Resume profile (§4, §7: PROFILE) ────────────────────────────────── */

export interface ResumeProfile {
  fileName: string;
  sizeKb: number;
  pages: number;
  parsed: boolean;
  targetRole: string;
  experience: string;
  education: string;
  skills: string[];
}
