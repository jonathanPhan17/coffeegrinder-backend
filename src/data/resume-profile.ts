import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamodb';
import { TABLE_NAME } from '../shared/env';
import { keys } from '../shared/keys';
import type { ResumeProfile } from '../types/domain';

// Reads/writes the single PROFILE item per user (USER#<id> / PROFILE, §7).

function toProfile(item: Record<string, unknown>): ResumeProfile {
  return {
    fileName: item.fileName as string,
    sizeKb: item.sizeKb as number,
    pages: item.pages as number,
    parsed: item.parsed as boolean,
    targetRole: item.targetRole as string,
    experience: item.experience as string,
    education: item.education as string,
    skills: (item.skills as string[]) ?? [],
  };
}

export async function getProfile(userId: string): Promise<ResumeProfile | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: keys.userProfile(userId) }),
  );
  return Item ? toProfile(Item) : null;
}

export async function putPendingProfile(
  userId: string,
  input: { fileName: string; sizeKb: number; s3Key: string },
): Promise<ResumeProfile> {
  const profile: ResumeProfile = {
    fileName: input.fileName,
    sizeKb: input.sizeKb,
    pages: 0,
    parsed: false,
    targetRole: '',
    experience: '',
    education: '',
    skills: [],
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.userProfile(userId), ...profile, s3Key: input.s3Key },
    }),
  );

  return profile;
}

// Records parse results, but only if the profile still points at the object the
// event was for — guards the re-upload race (EventBridge is at-least-once, and a
// stale event must not stamp old text over a newer upload). Returns false on the
// stale no-op.
export async function markParsed(
  userId: string,
  input: { s3Key: string; pages: number; text: string },
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: keys.userProfile(userId),
        UpdateExpression: 'SET #parsed = :parsed, #pages = :pages, #rawText = :rawText',
        ConditionExpression: '#s3Key = :eventKey',
        ExpressionAttributeNames: {
          '#parsed': 'parsed',
          '#pages': 'pages',
          '#rawText': 'rawText',
          '#s3Key': 's3Key',
        },
        ExpressionAttributeValues: {
          ':parsed': true,
          ':pages': input.pages,
          ':rawText': input.text,
          ':eventKey': input.s3Key,
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
