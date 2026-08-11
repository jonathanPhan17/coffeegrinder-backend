import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET_NAME } from './env';

// WHEN_REQUIRED keeps the SDK's default integrity checksum out of presigned URLs.
// Since v3.729 the default (WHEN_SUPPORTED) bakes x-amz-checksum-crc32=AAAAAA== — the
// CRC32 of an empty body — into the signed query, and S3 then rejects every real
// browser PUT made with the URL.
export const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });

/**
 * Presigned PUT URL the browser uses to upload a file straight to S3. Content-type and
 * content-length are part of the signature, so the URL is only valid for exactly the
 * declared type and byte size — the S3-side half of the upload size cap.
 */
export function presignUpload(
  key: string,
  contentType: string,
  sizeBytes: number,
  ttlSeconds: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    ContentLength: sizeBytes,
  });
  return getSignedUrl(s3, command, {
    expiresIn: ttlSeconds,
    // Without this the presigner leaves both headers out of SignedHeaders and S3
    // enforces neither the type nor the size.
    signableHeaders: new Set(['content-type', 'content-length']),
  });
}
