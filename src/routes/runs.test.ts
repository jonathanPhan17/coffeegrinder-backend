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

type RunBody = { count: number; screened: number };

// The payload the route handed to the state machine (the SFN input is a JSON string).
function startedPayload(): Record<string, unknown> {
  const [call] = sfnMock.commandCalls(StartExecutionCommand);
  return JSON.parse(call.args[0].input.input as string) as Record<string, unknown>;
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
    const body = res.json<RunBody>();
    expect(body.count).toBe(2); // …so run.count is overridden to what was actually stored.
    expect(body.screened).toBe(0);
    expect(startedPayload().postingIds).toHaveLength(2);
    await app.close();
  });

  it('caps stored postings at count and overrides run.count to the cap', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 1, postings: [posting, posting, posting] },
    });

    expect(res.json<RunBody>().count).toBe(1);
    expect(startedPayload().postingIds).toHaveLength(1);
    await app.close();
  });

  it('takes the Apify path for a query-only run: no postingIds, sends query + limit', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', location: 'NYC', count: 20 },
    });

    // run.count is the slider cap provisionally; the Fetch stage reconciles it to the
    // fetched count. The machine's HasPostingIds Choice keys off postingIds being absent.
    expect(res.json<RunBody>().count).toBe(20);
    const payload = startedPayload();
    expect(payload.postingIds).toBeUndefined();
    expect(payload).toMatchObject({ query: 'backend', location: 'NYC', limit: 20 });
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
