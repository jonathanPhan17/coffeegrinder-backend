export const RESUME_CONTENT_TYPE = 'application/pdf';
export const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Server-side resume size cap, enforced twice: the route 413s a larger declared size,
 * and the presigned URL signs content-length so S3 rejects a body that differs from
 * the declared size. The frontend applies the same limit client-side for fast feedback.
 */
export const MAX_RESUME_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Free-tier run allowance per account per UTC calendar month, enforced in POST /runs
 * before anything is persisted or charged (ARCHITECTURE.md paragraph 9.12).
 */
export const FREE_RUNS_PER_MONTH = 5;

/**
 * Site-wide run cap per UTC calendar day, across all accounts -- the blast-radius
 * backstop now that signup is open.
 */
// Bounds worst-case spend to ~25 x $0.11 ~= $2.75/day.
export const GLOBAL_RUNS_PER_DAY = 25;
