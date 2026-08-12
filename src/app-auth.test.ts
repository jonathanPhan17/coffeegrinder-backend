import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { buildTestApp } from './test-support/app';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

describe('identity seam', () => {
  beforeEach(() => {
    ddbMock.reset();
    sfnMock.reset();
  });

  it('401s a request with no identity before anything downstream runs', async () => {
    // Bare buildApp = the production default extractor, which finds no JWT claims here.
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/runs/some-id' });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>()).toEqual({ error: 'unauthenticated' });
    expect(ddbMock.calls()).toHaveLength(0);
    await app.close();
  });

  it('leaves /health open without identity', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('threads the caller identity into the state-machine payload', async () => {
    ddbMock.on(PutCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: 'arn:aws:states:us-east-1:0:execution/test',
      startDate: new Date(0),
    });
    const app = buildTestApp('user-a');
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', count: 1 },
    });

    expect(res.statusCode).toBe(201);
    const [call] = sfnMock.commandCalls(StartExecutionCommand);
    const payload = JSON.parse(call.args[0].input.input as string) as Record<string, unknown>;
    expect(payload.userId).toBe('user-a');
    await app.close();
  });
});
