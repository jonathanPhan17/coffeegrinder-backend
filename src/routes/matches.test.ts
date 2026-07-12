import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
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

describe('PATCH /matches/:id', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('updates the status and moves GSI1SK in lockstep', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [match] });
    ddbMock.on(UpdateCommand).resolves({});
    const app = buildApp();
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
    const app = buildApp();
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
    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/matches/p1',
      payload: { status: 'hired' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
