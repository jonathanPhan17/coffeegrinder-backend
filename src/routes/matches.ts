import type { FastifyInstance } from 'fastify';
import { getMatch, listMatches } from '../data/match';
import { DEFAULT_USER_ID } from '../shared/constants';

export async function matchesRoutes(app: FastifyInstance): Promise<void> {
  // GET /matches?run=<id> — scored matches for a run, best first.
  app.get<{ Querystring: { run?: string } }>('/matches', async (request, reply) => {
    const runId = request.query.run;
    if (!runId) return reply.code(400).send({ error: 'run query parameter is required' });
    return listMatches(runId);
  });

  // GET /matches/{id} — one match with its embedded evidence scorecard.
  app.get<{ Params: { id: string } }>('/matches/:id', async (request, reply) => {
    const match = await getMatch(DEFAULT_USER_ID, request.params.id);
    if (!match) return reply.code(404).send({ error: 'match not found' });
    return match;
  });
}
