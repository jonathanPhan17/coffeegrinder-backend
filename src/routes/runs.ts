import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumeQuota, quotaResetsAt, releaseQuota } from '../data/quota';
import { getRun, putPosting, putRun } from '../data/run';
import { FREE_RUNS_PER_MONTH, GLOBAL_RUNS_PER_DAY } from '../shared/constants';
import { startRunExecution } from '../shared/sfn';
import { PastedSource } from '../sources/pasted';
import { resolveSource } from '../sources/resolve';
import type { QuotaExceededBody, Run } from '../types/domain';

const pastedPostingSchema = z.object({
  title: z.string(),
  company: z.string(),
  // Must parse as a URL — the frontend deep-links it as the Apply target.
  applyUrl: z.string().url(),
  description: z.string(),
  location: z.string().optional(),
  remote: z.boolean().optional(),
});

/**
 * Matches the shipped frontend contract (startRun): { query, location?, remote?, count }.
 * `postings` is an optional extra for curl testing and the future paste tab — an array so a
 * single run can screen several pasted JDs (Apify will later populate the same fan-out).
 */
const createRunSchema = z.object({
  query: z.string(),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  // Bounds the fan-out — and therefore the Bedrock + Apify spend one request can trigger.
  // Frontend slider is 1–5; min 1 lets the curl/paste flow screen a single posting. The
  // pasted array gets the same cap: every stored posting becomes a paid scoring call.
  count: z.number().int().min(1).max(5),
  postings: z.array(pastedPostingSchema).min(1).max(5).optional(),
});

export async function runsRoutes(app: FastifyInstance): Promise<void> {
  // POST /runs — create a run, store any pasted postings, kick off the state machine.
  app.post('/runs', async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid run request', issues: parsed.error.issues });
    }
    const { query, location, remote, count } = parsed.data;

    // Quota gate before anything is persisted or charged: a rejected request must leave
    // zero rows and zero spend behind.
    const now = new Date();
    const quota = await consumeQuota(request.userId, now);
    if (!quota.ok) {
      return reply.code(429).send(
        quota.scope === 'monthly'
          ? ({
              error: 'monthly free-run limit reached',
              code: 'monthly_quota',
              limit: FREE_RUNS_PER_MONTH,
              resetsAt: quotaResetsAt('monthly', now),
            } satisfies QuotaExceededBody)
          : ({
              error: 'daily site-wide run cap reached',
              code: 'daily_cap',
              limit: GLOBAL_RUNS_PER_DAY,
              resetsAt: quotaResetsAt('daily', now),
            } satisfies QuotaExceededBody),
      );
    }

    try {
      const source = resolveSource(parsed.data);
      const runId = randomUUID();

      // Pasted runs normalize + persist up front (capped at `count`), so run.count is exact and
      // the machine can skip straight to screening. Apify runs carry only the search terms:
      // run.count is the slider cap provisionally, and the Fetch stage reconciles it to the
      // actually-fetched count (reconcileRunCount) so screened/count still reaches 100%.
      let runCount = count;
      let postingIds: string[] | undefined;
      if (source.kind === 'pasted') {
        const normalized = await new PastedSource(source.postings).fetch({ query, location, limit: count });
        await Promise.all(normalized.map((posting) => putPosting(runId, posting)));
        postingIds = normalized.map((posting) => posting.sourceId);
        runCount = normalized.length;
      }

      const run: Run = {
        id: runId,
        status: 'queued',
        count: runCount,
        query,
        location,
        remote,
        screened: 0,
        createdAt: new Date().toISOString(),
      };
      await putRun(request.userId, run);

      try {
        await startRunExecution({
          name: runId,
          payload:
            postingIds !== undefined
              ? { userId: request.userId, runId, postingIds }
              : { userId: request.userId, runId, query, limit: count, ...(location ? { location } : {}) },
        });
      } catch (error) {
        // The run row is already stored: without this it would sit queued forever and the
        // frontend would poll a run no state machine is driving.
        try {
          await putRun(request.userId, { ...run, status: 'error' });
        } catch (markError) {
          request.log.error({ err: markError }, 'failed to mark orphaned run as error');
        }
        throw error;
      }

      return reply.code(201).send(run);
    } catch (error) {
      // A run that never started must not burn a free slot: give back what the quota
      // gate consumed, then let the original error reach the 500 handler. releaseQuota
      // never throws, so the real failure is never masked.
      await releaseQuota(request.userId, now);
      throw error;
    }
  });

  // GET /runs/{id} — poll run status; the frontend polls this until status is done.
  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const run = await getRun(request.userId, request.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return run;
  });
}
