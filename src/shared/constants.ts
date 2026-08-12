export const RESUME_CONTENT_TYPE = 'application/pdf';
export const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Server-side resume size cap, enforced twice: the route 413s a larger declared size,
 * and the presigned URL signs content-length so S3 rejects a body that differs from
 * the declared size. The frontend applies the same limit client-side for fast feedback.
 */
export const MAX_RESUME_SIZE_BYTES = 10 * 1024 * 1024;
