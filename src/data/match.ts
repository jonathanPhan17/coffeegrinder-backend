import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamodb';
import { TABLE_NAME } from '../shared/env';
import { keys } from '../shared/keys';
import type { Match } from '../types/domain';

// Match items embed their evidence[] (§7: single-homed on the match, not separate EVIDENCE#
// rows — keeps GET /matches?run= a single query). GSI1 (USER#<id> / STATUS#<status>) lets a
// match be found by id without its run, and backs the pipeline board later.

function toMatch(item: Record<string, unknown>): Match {
  return {
    id: item.id as string,
    runId: item.runId as string,
    posting: item.posting as Match['posting'],
    score: item.score as number,
    fitTier: item.fitTier as Match['fitTier'],
    summary: item.summary as string,
    evidence: (item.evidence as Match['evidence']) ?? [],
    status: item.status as Match['status'],
  };
}

export async function putMatch(userId: string, runId: string, match: Match): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...keys.match(runId, match.id),
        GSI1PK: `USER#${userId}`,
        GSI1SK: `STATUS#${match.status}`,
        ...match,
      },
    }),
  );
}

export async function listMatches(runId: string): Promise<Match[]> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'MATCH#' },
    }),
  );
  return (Items ?? []).map(toMatch).sort((a, b) => b.score - a.score);
}

export async function getMatch(userId: string, matchId: string): Promise<Match | null> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'STATUS#' },
    }),
  );
  return (Items ?? []).map(toMatch).find((m) => m.id === matchId) ?? null;
}
