import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health';
import { resumeRoutes } from './routes/resume';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(healthRoutes);
  app.register(resumeRoutes);
  return app;
}
