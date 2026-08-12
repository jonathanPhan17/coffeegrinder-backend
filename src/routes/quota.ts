import type { FastifyInstance } from 'fastify';
import { getQuota } from '../data/quota';

export async function quotaRoutes(app: FastifyInstance): Promise<void> {
  // GET /quota -- both run-quota windows so the frontend can show remaining runs.
  // Absent counter items just mean nothing consumed this period, so there is no 404 case.
  app.get('/quota', async (request) => getQuota(request.userId, new Date()));
}
