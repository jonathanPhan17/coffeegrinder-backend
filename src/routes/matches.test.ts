import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_USER, buildTestApp } from '../test-support/app';
import type { Match } from '../types/domain';

const ddbMock = mockClient(DynamoDBDocumentClient);

const match: Match = {
  id: 'p1',
  runId: 'r1',
  posting: {
    sourceId: 'p1',
    source: 'pasted',
    title: 'Backend Engineer',
    company: 'Acme',
    description: 'Build things.',
    applyUrl: 'https://acme.example/jobs/1',
  },
  score: 82,
  fitTier: 'strong',
  summary: 'Strong fit.',
  evidence: [],
  status: 'matched',
};

describe('GET /matches', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('without ?run returns all the users matches via GSI1, best score first', async () => {
    const better: Match = { ...match, id: 'p2', runId: 'r2', score: 95 };
    ddbMock.on(QueryCommand).resolves({ Items: [match, better] });
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/matches' });

    expect(res.statusCode).toBe(200);
    expect(res.json<Match[]>().map((m) => m.id)).toEqual(['p2', 'p1']);
    const [call] = ddbMock.commandCalls(QueryCommand);
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.ExpressionAttributeValues?.[':pk']).toBe(`USER#${TEST_USER}`);
    await app.close();
  });

  it('with ?run queries the runs item collection, not the index', async () => {
    // The route checks run ownership first — the run item must exist under this user.
    ddbMock.on(GetCommand).resolves({
      Item: { id: 'r1', status: 'done', count: 1, query: 'x', createdAt: '2026-01-01' },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [match] });
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/matches?run=r1' });

    expect(res.statusCode).toBe(200);
    const [call] = ddbMock.commandCalls(QueryCommand);
    expect(call.args[0].input.IndexName).toBeUndefined();
    expect(call.args[0].input.ExpressionAttributeValues?.[':pk']).toBe('RUN#r1');
    await app.close();
  });

  it('404s a run the caller does not own without ever querying its matches', async () => {
    // Matches are keyed RUN#-only, so the ownership check on the (user-keyed) run item
    // is the only thing between an authenticated caller and another user's matches.
    ddbMock.on(GetCommand).resolves({});
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/matches?run=r-1' });

    expect(res.statusCode).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    await app.close();
  });
});

describe('PATCH /matches/:id', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('updates the status and moves GSI1SK in lockstep', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [match] });
    ddbMock.on(UpdateCommand).resolves({});
    const app = buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/matches/p1',
      payload: { status: 'shortlisted' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<Match>().status).toBe('shortlisted');
    const [call] = ddbMock.commandCalls(UpdateCommand);
    expect(call.args[0].input.Key).toEqual({ PK: 'RUN#r1', SK: 'MATCH#p1' });
    expect(call.args[0].input.ExpressionAttributeValues?.[':gsi1sk']).toBe('STATUS#shortlisted');
    await app.close();
  });

  it('404s for an unknown match without writing anything', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const app = buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/matches/nope',
      payload: { status: 'applied' },
    });

    expect(res.statusCode).toBe(404);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    await app.close();
  });

  it('rejects a status outside the pipeline enum', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/matches/p1',
      payload: { status: 'hired' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
