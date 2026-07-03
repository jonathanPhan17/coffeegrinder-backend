import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { EventBridgeEvent } from 'aws-lambda';
import { structureResume } from '../ai/resume-structure';
import { saveParsedProfile } from '../data/resume-profile';
import { logger } from '../shared/logger';
import { extractPdfText } from '../shared/pdf';
import { s3 } from '../shared/s3';

interface ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size: number };
}

// resumes/<userId>/<uuid>.pdf
function userIdFromKey(key: string): string {
  return key.split('/')[1];
}

// S3 ObjectCreated (via EventBridge) → extract text → structure it → update the profile.
export async function handler(
  event: EventBridgeEvent<'Object Created', ObjectCreatedDetail>,
): Promise<void> {
  const { key } = event.detail.object;
  const bucketName = event.detail.bucket.name;

  const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  if (!object.Body) throw new Error(`empty S3 body for ${key}`);
  const buffer = Buffer.from(await object.Body.transformToByteArray());

  // Any of these throw on failure — the event surfaces in CloudWatch and EventBridge
  // retries. A parseFailed flag on the profile is a fast-follow.
  const { text, pages } = await extractPdfText(buffer);
  const structured = await structureResume(text);

  const applied = await saveParsedProfile(userIdFromKey(key), {
    s3Key: key,
    pages,
    text,
    ...structured,
  });

  if (applied) {
    logger.info('resume parsed and structured', { key, pages });
  } else {
    logger.info('stale event; profile points at a newer upload, skipping', { key });
  }
}
