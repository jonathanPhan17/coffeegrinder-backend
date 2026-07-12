import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health';
import { matchesRoutes } from './routes/matches';
import { resumeRoutes } from './routes/resume';
import { runsRoutes } from './routes/runs';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  // API Gateway's $default route forwards even CORS preflights to this Lambda (documented
  // HTTP API gotcha: a catch-all route wins over automatic preflight handling), so answer
  // them OK — the gateway appends the Access-Control-* headers itself. Browsers require
  // an ok status here; a 404 blocks every cross-origin call before it starts.
  app.options('*', async (_request, reply) => reply.code(204).send());
  app.register(healthRoutes);
  app.register(resumeRoutes);
  app.register(runsRoutes);
  app.register(matchesRoutes);
  return app;
}
