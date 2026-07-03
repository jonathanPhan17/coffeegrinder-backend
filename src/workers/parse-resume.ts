import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { EventBridgeEvent } from 'aws-lambda';
import { markParsed } from '../data/resume-profile';
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

// S3 ObjectCreated (via EventBridge) → extract text → update the profile.
export async function handler(
  event: EventBridgeEvent<'Object Created', ObjectCreatedDetail>,
): Promise<void> {
  const { key } = event.detail.object;
  const bucketName = event.detail.bucket.name;

  const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  if (!object.Body) throw new Error(`empty S3 body for ${key}`);
  const buffer = Buffer.from(await object.Body.transformToByteArray());

  // Throws on a corrupt/encrypted PDF — surfaces in CloudWatch and lets
  // EventBridge retry. A parseFailed flag on the profile is a fast-follow.
  const { text, pages } = await extractPdfText(buffer);

  const applied = await markParsed(userIdFromKey(key), { s3Key: key, pages, text });
  if (!applied) {
    console.log(`stale event for ${key}; profile now points at a newer upload — skipping`);
  }
}
