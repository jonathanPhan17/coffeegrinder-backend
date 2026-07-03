import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamodb';
import { TABLE_NAME } from '../shared/env';
import { keys } from '../shared/keys';
import type { JobPosting, Run } from '../types/domain';

// Reads/writes RUN and POSTING items (§7). Status transitions after kickoff are owned
// by the state machine (DynamoDB UpdateItem states), not this module.

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
