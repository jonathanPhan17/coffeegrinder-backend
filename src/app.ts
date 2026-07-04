import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health';
import { matchesRoutes } from './routes/matches';
import { resumeRoutes } from './routes/resume';
import { runsRoutes } from './routes/runs';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(healthRoutes);
  app.register(resumeRoutes);
  app.register(runsRoutes);
  app.register(matchesRoutes);
  return app;
}
