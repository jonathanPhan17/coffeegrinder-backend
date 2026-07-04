import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { PostingCriteria } from '../ai/posting-criteria';
import { ddb } from '../shared/dynamodb';
import { TABLE_NAME } from '../shared/env';
import { keys } from '../shared/keys';
import type { JobPosting, Run } from '../types/domain';

// Reads/writes RUN and POSTING items (§7). Status transitions after kickoff are owned by
// the state machine (DynamoDB UpdateItem states), not this module.

function toRun(item: Record<string, unknown>): Run {
  return {
    id: item.id as string,
    status: item.status as Run['status'],
    count: item.count as number,
    query: item.query as string,
    location: item.location as string | undefined,
    remote: item.remote as boolean | undefined,
    screened: item.screened as number | undefined,
    createdAt: item.createdAt as string,
  };
}

function toPosting(item: Record<string, unknown>): JobPosting {
  return {
    sourceId: item.sourceId as string,
    source: item.source as JobPosting['source'],
    title: item.title as string,
    company: item.company as string,
    location: item.location as string | undefined,
    remote: item.remote as boolean | undefined,
    description: item.description as string,
    applyUrl: item.applyUrl as string,
    salary: item.salary as JobPosting['salary'],
    postedAt: item.postedAt as string | undefined,
  };
}

export async function putRun(userId: string, run: Run): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.run(userId, run.id), ...run },
    }),
  );
}

export async function getRun(userId: string, runId: string): Promise<Run | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: keys.run(userId, runId) }),
  );
  return Item ? toRun(Item) : null;
}

export async function putPosting(runId: string, posting: JobPosting): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...keys.posting(runId, posting.sourceId), ...posting },
    }),
  );
}

export async function getPosting(runId: string, postingId: string): Promise<JobPosting | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: keys.posting(runId, postingId) }),
  );
  return Item ? toPosting(Item) : null;
}

// The posting plus its extracted criteria in one read — the score worker needs both, and
// they live on the same POSTING item. Null if the posting is missing or not yet enriched.
export async function getPostingWithCriteria(
  runId: string,
  postingId: string,
): Promise<{ posting: JobPosting; criteria: PostingCriteria } | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: keys.posting(runId, postingId) }),
  );
  const criteria = Item?.criteria as PostingCriteria | undefined;
  if (!Item || !criteria) return null;
  return { posting: toPosting(Item), criteria };
}

export async function saveCriteria(
  runId: string,
  postingId: string,
  criteria: PostingCriteria,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: keys.posting(runId, postingId),
      UpdateExpression: 'SET #criteria = :criteria',
      ExpressionAttributeNames: { '#criteria': 'criteria' },
      ExpressionAttributeValues: { ':criteria': criteria },
    }),
  );
}
