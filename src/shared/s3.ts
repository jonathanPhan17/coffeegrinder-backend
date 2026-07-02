import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET_NAME } from './env';

export const s3 = new S3Client({});

/** Presigned PUT URL the browser uses to upload a file straight to S3. */
export function presignUpload(
  key: string,
  contentType: string,
  ttlSeconds: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, { expiresIn: ttlSeconds });
}
