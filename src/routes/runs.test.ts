import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

const posting = {
  title: 'Backend Engineer',
  company: 'Acme',
  applyUrl: 'https://acme.example/jobs/1',
  description: 'Build things.',
};

// The postingIds the route handed to the state machine (the SFN input is a JSON payload).
function startedPostingIds(): string[] {
  const [call] = sfnMock.commandCalls(StartExecutionCommand);
  const payload = JSON.parse(call.args[0].input.input as string);
  return payload.postingIds;
}

describe('POST /runs', () => {
  beforeEach(() => {
    ddbMock.reset();
    sfnMock.reset();
    ddbMock.on(PutCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: 'arn:aws:states:us-east-1:0:execution/test',
      startDate: new Date(0),
    });
  });

  it('stores every pasted posting and reports count = postings stored', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      // Slider count (50) exceeds the two pasted postings…
      payload: { query: 'backend', count: 50, postings: [posting, posting] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.count).toBe(2); // …so run.count is overridden to what was actually stored.
    expect(body.screened).toBe(0);
    expect(startedPostingIds()).toHaveLength(2);
    await app.close();
  });

  it('caps stored postings at count and overrides run.count to the cap', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 1, postings: [posting, posting, posting] },
    });

    expect(res.json().count).toBe(1);
    expect(startedPostingIds()).toHaveLength(1);
    await app.close();
  });

  it('keeps the slider count for a query-only run and sends no postingIds', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 20 },
    });

    expect(res.json().count).toBe(20);
    expect(startedPostingIds()).toEqual([]);
    await app.close();
  });

  it('rejects an empty postings array', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 5, postings: [] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
