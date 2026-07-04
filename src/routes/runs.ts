import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRun, putPosting, putRun } from '../data/run';
import { DEFAULT_USER_ID } from '../shared/constants';
import { startRunExecution } from '../shared/sfn';
import { PastedSource } from '../sources/pasted';
import type { JobPosting, Run } from '../types/domain';

const pastedPostingSchema = z.object({
  title: z.string(),
  company: z.string(),
  applyUrl: z.string(),
  description: z.string(),
  location: z.string().optional(),
  remote: z.boolean().optional(),
});

// Matches the shipped frontend contract (startRun): { query, location?, remote?, count }.
// `postings` is an optional extra for curl testing and the future paste tab — an array so a
// single run can screen several pasted JDs (Apify will later populate the same fan-out).
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
    const { query, location, remote, count, postings } = parsed.data;

    // Normalize pasted JDs up front (capped at `count`) so the stored run.count reflects the
    // fan-out that will actually run. The frontend divides screened/count for progress, so a
    // pasted run of fewer-than-slider postings still reaches 100%.
    const normalized: JobPosting[] = postings
      ? await new PastedSource(postings).fetch({ query, location, limit: count })
      : [];

    const run: Run = {
      id: randomUUID(),
      status: 'queued',
      count: postings ? normalized.length : count,
      query,
      location,
      remote,
      screened: 0,
      createdAt: new Date().toISOString(),
    };
    await putRun(DEFAULT_USER_ID, run);

    // Store every posting before kickoff so the machine's ExtractCriteria can read them.
    await Promise.all(normalized.map((posting) => putPosting(run.id, posting)));
    const postingIds = normalized.map((posting) => posting.sourceId);

    await startRunExecution({
      name: run.id,
      payload: { userId: DEFAULT_USER_ID, runId: run.id, postingIds },
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
