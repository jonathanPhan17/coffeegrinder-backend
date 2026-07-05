import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { getRun } from './run';

const ddbMock = mockClient(DynamoDBDocumentClient);

const baseItem = {
  id: 'run-1',
  status: 'done',
  count: 5,
  query: 'engineer',
  screened: 3,
  createdAt: '2026-07-04T00:00:00.000Z',
};

describe('getRun (toRun projection)', () => {
  beforeEach(() => ddbMock.reset());

  it('projects the failed counter when the item carries it', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, failed: 2 } });

    const run = await getRun('me', 'run-1');

    expect(run?.failed).toBe(2);
    expect(run?.screened).toBe(3);
  });

  it('leaves failed undefined when the run never recorded a failure', async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseItem });

    const run = await getRun('me', 'run-1');

    expect(run?.failed).toBeUndefined();
  });
});
