import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeQuota, getQuota, quotaResetsAt, releaseQuota } from './quota';

const ddbMock = mockClient(DynamoDBDocumentClient);

// Fixed clock so period keys and resets are deterministic regardless of when tests run.
const NOW = new Date('2026-08-11T15:30:00.000Z');

function cancelled(monthlyCode: string, dailyCode: string): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'transaction cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: monthlyCode }, { Code: dailyCode }],
  });
}

beforeEach(() => {
  ddbMock.reset();
});

describe('consumeQuota', () => {
  it('increments both counters in one transaction keyed to the UTC period', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(consumeQuota('u1', NOW)).resolves.toEqual({ ok: true });
    const [call] = ddbMock.commandCalls(TransactWriteCommand);
    const items = call.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Update?.Key).toEqual({ PK: 'USER#u1', SK: 'QUOTA#2026-08' });
    expect(items[1]?.Update?.Key).toEqual({ PK: 'QUOTA#GLOBAL', SK: 'DAY#2026-08-11' });
  });

  it('maps a monthly condition loss to scope monthly', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('ConditionalCheckFailed', 'None'));
    await expect(consumeQuota('u1', NOW)).resolves.toEqual({ ok: false, scope: 'monthly' });
  });

  it('maps a daily condition loss to scope daily', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'ConditionalCheckFailed'));
    await expect(consumeQuota('u1', NOW)).resolves.toEqual({ ok: false, scope: 'daily' });
  });

  it('reports monthly when both counters tripped (the user-actionable one)', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed'));
    await expect(consumeQuota('u1', NOW)).resolves.toEqual({ ok: false, scope: 'monthly' });
  });

  it('propagates non-quota errors', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('dynamo down'));
    await expect(consumeQuota('u1', NOW)).rejects.toThrow('dynamo down');
  });

  it('rethrows cancellations that hit no condition (conflict/throttle is not a full quota)', async () => {
    // Every consume touches the shared daily item, so concurrent runs can cancel each
    // other with TransactionConflict -- nothing was consumed and a 429 would be a lie.
    ddbMock.on(TransactWriteCommand).rejects(cancelled('None', 'TransactionConflict'));
    await expect(consumeQuota('u1', NOW)).rejects.toThrow(TransactionCanceledException);
  });

  it('rethrows a cancellation with no reasons at all', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(new TransactionCanceledException({ message: 'cancelled', $metadata: {} }));
    await expect(consumeQuota('u1', NOW)).rejects.toThrow(TransactionCanceledException);
  });
});

describe('releaseQuota', () => {
  it('decrements both period counters', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await releaseQuota('u1', NOW);
    const updates = ddbMock.commandCalls(UpdateCommand).map((call) => call.args[0].input);
    expect(updates.map((input) => input.Key)).toEqual([
      { PK: 'USER#u1', SK: 'QUOTA#2026-08' },
      { PK: 'QUOTA#GLOBAL', SK: 'DAY#2026-08-11' },
    ]);
    for (const input of updates) {
      expect(input.ExpressionAttributeValues?.[':minusOne']).toBe(-1);
    }
  });

  it('swallows failures instead of masking the error that triggered the release', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('counter gone'));
    await expect(releaseQuota('u1', NOW)).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });
});

describe('quotaResetsAt', () => {
  it('is the next UTC month start for monthly and the next UTC midnight for daily', () => {
    expect(quotaResetsAt('monthly', NOW)).toBe('2026-09-01T00:00:00.000Z');
    expect(quotaResetsAt('daily', NOW)).toBe('2026-08-12T00:00:00.000Z');
  });

  it('rolls a December date into January of the next year', () => {
    const dec = new Date('2026-12-31T23:59:59.000Z');
    expect(quotaResetsAt('monthly', dec)).toBe('2027-01-01T00:00:00.000Z');
    expect(quotaResetsAt('daily', dec)).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('getQuota', () => {
  it('clamps remaining at zero when used exceeds the limit', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { used: 99 } });

    const quota = await getQuota('u1', NOW);
    expect(quota.monthly).toEqual({
      used: 99,
      limit: 5,
      remaining: 0,
      resetsAt: '2026-09-01T00:00:00.000Z',
    });
    expect(quota.daily.remaining).toBe(0);
  });
});
