import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMatch, listMatches, listUserMatches, updateMatchStatus } from '../data/match';
import { DEFAULT_USER_ID } from '../shared/constants';

/** Matches the shipped frontend contract (updateMatchStatus): { status: PipelineStatus }. */
const updateMatchSchema = z.object({
  status: z.enum(['matched', 'shortlisted', 'applied', 'interviewing', 'offer', 'rejected']),
});

export async function matchesRoutes(app: FastifyInstance): Promise<void> {
  // GET /matches?run=<id> — scored matches for a run; without ?run, everything the
  // user has across runs (the pipeline board). Both best first.
  app.get<{ Querystring: { run?: string } }>('/matches', async (request) => {
    const runId = request.query.run;
    return runId ? listMatches(runId) : listUserMatches(DEFAULT_USER_ID);
  });

  // GET /matches/{id} — one match with its embedded evidence scorecard.
  app.get<{ Params: { id: string } }>('/matches/:id', async (request, reply) => {
    const match = await getMatch(DEFAULT_USER_ID, request.params.id);
    if (!match) return reply.code(404).send({ error: 'match not found' });
    return match;
  });

  // PATCH /matches/{id} — move a match across the pipeline board.
  app.patch<{ Params: { id: string } }>('/matches/:id', async (request, reply) => {
    const parsed = updateMatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid match update', issues: parsed.error.issues });
    }
    const updated = await updateMatchStatus(DEFAULT_USER_ID, request.params.id, parsed.data.status);
    if (!updated) return reply.code(404).send({ error: 'match not found' });
    return updated;
  });
}
