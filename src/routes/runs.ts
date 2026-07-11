import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRun, putPosting, putRun } from '../data/run';
import { DEFAULT_USER_ID } from '../shared/constants';
import { startRunExecution } from '../shared/sfn';
import { PastedSource } from '../sources/pasted';
import { resolveSource } from '../sources/resolve';
import type { Run } from '../types/domain';

const pastedPostingSchema = z.object({
  title: z.string(),
  company: z.string(),
  applyUrl: z.string(),
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
  // Bounds the fan-out (and Bedrock spend). Frontend slider is 5–50; min 1 lets the
  // curl/paste flow screen a single posting.
  count: z.number().int().min(1).max(50),
  postings: z.array(pastedPostingSchema).min(1).max(50).optional(),
});

export async function runsRoutes(app: FastifyInstance): Promise<void> {
  // POST /runs — create a run, store any pasted postings, kick off the state machine.
  app.post('/runs', async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid run request', issues: parsed.error.issues });
    }
    const { query, location, remote, count } = parsed.data;
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
    await putRun(DEFAULT_USER_ID, run);

    await startRunExecution({
      name: runId,
      payload:
        postingIds !== undefined
          ? { userId: DEFAULT_USER_ID, runId, postingIds }
          : { userId: DEFAULT_USER_ID, runId, query, limit: count, ...(location ? { location } : {}) },
    });

    return reply.code(201).send(run);
  });

  // GET /runs/{id} — poll run status; the frontend polls this until status is done.
  app.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const run = await getRun(DEFAULT_USER_ID, request.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return run;
  });
}
