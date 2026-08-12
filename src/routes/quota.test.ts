import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/app';
import type { Quota } from '../types/domain';

const ddbMock = mockClient(DynamoDBDocumentClient);

// Both windows reset on a UTC period boundary, so resetsAt is always a midnight ISO.
const MIDNIGHT_ISO = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;

describe('GET /quota', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({});
  });

  it('reports zero used and full remaining when no counter items exist', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/quota' });

    expect(res.statusCode).toBe(200);
    const body = res.json<Quota>();
    expect(body.monthly).toMatchObject({ used: 0, limit: 5, remaining: 5 });
    expect(body.daily).toMatchObject({ used: 0, limit: 25, remaining: 25 });
    expect(body.monthly.resetsAt).toMatch(MIDNIGHT_ISO);
    expect(body.daily.resetsAt).toMatch(MIDNIGHT_ISO);
    await app.close();
  });

  it('computes used and remaining from the stored period counters', async () => {
    // Branch on the key shape, not exact period strings: the route derives its own
    // new Date(), which can cross a UTC day/month boundary between mock setup and
    // the request -- an exact-key matcher would flake at midnight.
    ddbMock.on(GetCommand).callsFake((input: { Key?: { PK?: string } }) => ({
      Item: { used: input.Key?.PK === 'QUOTA#GLOBAL' ? 7 : 2 },
    }));
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/quota' });

    expect(res.statusCode).toBe(200);
    const body = res.json<Quota>();
    expect(body.monthly).toMatchObject({ used: 2, limit: 5, remaining: 3 });
    expect(body.daily).toMatchObject({ used: 7, limit: 25, remaining: 18 });
    await app.close();
  });
});
