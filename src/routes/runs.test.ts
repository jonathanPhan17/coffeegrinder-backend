import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/app';

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
    // The quota gate's transact (and releaseQuota's updates) must succeed by default,
    // or every POST here would 500 before reaching the code under test.
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: 'arn:aws:states:us-east-1:0:execution/test',
      startDate: new Date(0),
    });
  });

  it('stores every pasted posting and reports count = postings stored', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      // Slider count (5) exceeds the two pasted postings…
      payload: { query: 'backend', count: 5, postings: [posting, posting] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<RunBody>();
    expect(body.count).toBe(2); // …so run.count is overridden to what was actually stored.
    expect(body.screened).toBe(0);
    expect(startedPayload().postingIds).toHaveLength(2);
    // The quota gate consumed exactly one slot for the whole run.
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    await app.close();
  });

  it('caps stored postings at count and overrides run.count to the cap', async () => {
    const app = buildTestApp();
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
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', location: 'NYC', count: 5 },
    });

    // run.count is the slider cap provisionally; the Fetch stage reconciles it to the
    // fetched count. The machine's HasPostingIds Choice keys off postingIds being absent.
    expect(res.json<RunBody>().count).toBe(5);
    const payload = startedPayload();
    expect(payload.postingIds).toBeUndefined();
    expect(payload).toMatchObject({ query: 'backend', location: 'NYC', limit: 5 });
    await app.close();
  });

  it('rejects a count over the spend cap', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', count: 6 },
    });

    expect(res.statusCode).toBe(400);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    await app.close();
  });

  it('rejects a pasted-postings array over the spend cap', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 5, postings: Array.from({ length: 6 }, () => posting) },
    });

    expect(res.statusCode).toBe(400);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    await app.close();
  });

  it('rejects an empty postings array', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 5, postings: [] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a posting whose applyUrl is not a url', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'x', count: 5, postings: [{ ...posting, applyUrl: 'not-a-url' }] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('marks the stored run as error and releases the quota slot when the kickoff fails', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('sfn unavailable'));
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', count: 5 },
    });

    expect(res.statusCode).toBe(500);
    const statuses = ddbMock
      .commandCalls(PutCommand)
      .map((call) => (call.args[0].input.Item as Record<string, unknown>).status);
    expect(statuses).toEqual(['queued', 'error']);
    // A run that never started must not burn a slot: both counters got ADD -1 back.
    const decrements = ddbMock
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.ExpressionAttributeValues?.[':minusOne'] === -1);
    expect(decrements).toHaveLength(2);
    await app.close();
  });

  it('429s with monthly_quota before anything persists when the monthly limit is hit', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'quota exhausted',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', count: 5, postings: [posting] },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json<{ code: string; limit: number; resetsAt: string }>();
    expect(body.code).toBe('monthly_quota');
    expect(body.limit).toBe(5);
    expect(body.resetsAt).toMatch(/T00:00:00\.000Z$/);
    // Rejected over-quota means zero rows written and zero spend kicked off.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    await app.close();
  });

  it('500s (not 429) when the transact cancels without any condition failure', async () => {
    // A TransactionConflict on the shared daily item consumes nothing -- misreading it
    // as a cap would tell a healthy user to come back tomorrow.
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'conflict',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
      }),
    );
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', count: 5 },
    });

    expect(res.statusCode).toBe(500);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    await app.close();
  });

  it('429s with daily_cap when the global daily cap is the one that trips', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'quota exhausted',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      }),
    );
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/runs',
      payload: { query: 'backend', count: 5 },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json<{ code: string; limit: number }>();
    expect(body.code).toBe('daily_cap');
    expect(body.limit).toBe(25);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    await app.close();
  });
});
