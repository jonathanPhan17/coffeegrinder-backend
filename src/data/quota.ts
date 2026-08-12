import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { FREE_RUNS_PER_MONTH, GLOBAL_RUNS_PER_DAY } from '../shared/constants';
import { ddb } from '../shared/dynamodb';
import { TABLE_NAME } from '../shared/env';
import { keys } from '../shared/keys';
import type { Quota, QuotaWindow } from '../types/domain';

// Reads/writes the two run-quota counter items (USER#<id>/QUOTA#<yyyy-mm> and
// QUOTA#GLOBAL/DAY#<yyyy-mm-dd>, ARCHITECTURE.md section 7). Every function takes `now` so tests can pin the
// period; routes pass `new Date()`. Periods are UTC slices of the ISO timestamp.

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * ISO timestamp at which the given quota window rolls over: the next UTC month start
 * for 'monthly', the next UTC midnight for 'daily'. Also the `resetsAt` the 429 body
 * and GET /quota expose.
 */
export function quotaResetsAt(scope: 'monthly' | 'daily', now: Date): string {
  const next =
    scope === 'monthly'
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(next).toISOString();
}

/**
 * Atomically consume one run slot from BOTH counters (per-user monthly, global daily)
 * or neither. Returns { ok: false, scope } with the exhausted window when a limit is
 * hit; any non-quota error propagates (500).
 */
export async function consumeQuota(
  userId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; scope: 'monthly' | 'daily' }> {
  try {
    // One transaction, not two conditional updates: if the daily guard loses after the
    // monthly increment landed, sequential writes would need compensation logic -- the
    // transact rolls both back and neither counter is consumed.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: keys.quotaMonth(userId, monthOf(now)),
              UpdateExpression: 'ADD #used :one',
              ConditionExpression: 'attribute_not_exists(#used) OR #used < :limit',
              ExpressionAttributeNames: { '#used': 'used' },
              ExpressionAttributeValues: { ':one': 1, ':limit': FREE_RUNS_PER_MONTH },
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: keys.quotaDay(dayOf(now)),
              UpdateExpression: 'ADD #used :one',
              ConditionExpression: 'attribute_not_exists(#used) OR #used < :limit',
              ExpressionAttributeNames: { '#used': 'used' },
              ExpressionAttributeValues: { ':one': 1, ':limit': GLOBAL_RUNS_PER_DAY },
            },
          },
        ],
      }),
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      // Index order matches TransactItems: [monthly, daily]. Only ConditionalCheckFailed
      // means a limit was actually hit -- the transact also cancels on conflicts and
      // throttling (every consume touches the shared daily item), where nothing was
      // consumed and a 429 would falsely send a healthy user away until tomorrow.
      const monthlyHit = reasons[0]?.Code === 'ConditionalCheckFailed';
      const dailyHit = reasons[1]?.Code === 'ConditionalCheckFailed';
      if (monthlyHit || dailyHit) {
        // When both tripped, report monthly -- it is the one the user can act on
        // (the daily cap is site-wide).
        return { ok: false, scope: monthlyHit ? 'monthly' : 'daily' };
      }
    }
    throw err;
  }
}

// Release goes through a no-retry client: UpdateItem has no idempotency token (unlike
// the transact), so an SDK retry after a lost response would apply ADD -1 twice and
// silently grant an extra paid run. Single-shot keeps best-effort failing in the cheap
// direction -- worst case one burnt slot, never an extra grant.
const ddbNoRetry = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Best-effort compensation: give back the slot consumeQuota took, when the run never
 * actually started. Never throws.
 */
export async function releaseQuota(userId: string, now: Date): Promise<void> {
  const decrement = (key: { PK: string; SK: string }) =>
    ddbNoRetry.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'ADD #used :minusOne',
        // Never decrement below zero or resurrect a missing counter -- a phantom
        // negative would hand out extra free runs.
        ConditionExpression: 'attribute_exists(PK) AND #used > :zero',
        ExpressionAttributeNames: { '#used': 'used' },
        ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
      }),
    );
  // Swallow every failure: this runs on an already-failing request, and losing the
  // decrement only burns one slot -- acceptable next to masking the original error.
  await Promise.allSettled([
    decrement(keys.quotaMonth(userId, monthOf(now))),
    decrement(keys.quotaDay(dayOf(now))),
  ]);
}

function toWindow(used: number, limit: number, resetsAt: string): QuotaWindow {
  return { used, limit, remaining: Math.max(0, limit - used), resetsAt };
}

/**
 * Both quota windows for GET /quota. Absent counter items (nothing consumed this
 * period yet) read as used 0.
 */
export async function getQuota(userId: string, now: Date): Promise<Quota> {
  const [monthly, daily] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.quotaMonth(userId, monthOf(now)) })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: keys.quotaDay(dayOf(now)) })),
  ]);
  return {
    monthly: toWindow(
      (monthly.Item?.used as number | undefined) ?? 0,
      FREE_RUNS_PER_MONTH,
      quotaResetsAt('monthly', now),
    ),
    daily: toWindow(
      (daily.Item?.used as number | undefined) ?? 0,
      GLOBAL_RUNS_PER_DAY,
      quotaResetsAt('daily', now),
    ),
  };
}
