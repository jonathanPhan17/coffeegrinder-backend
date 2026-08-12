import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { healthRoutes } from './routes/health';
import { matchesRoutes } from './routes/matches';
import { quotaRoutes } from './routes/quota';
import { resumeRoutes } from './routes/resume';
import { runsRoutes } from './routes/runs';
import { lambdaJwtIdentity } from './shared/auth';

/**
 * Tests inject identity via identityExtractor (and local.ts pins a fixed dev id);
 * production omits it, so identity comes only from the gateway-verified JWT claims
 * (lambdaJwtIdentity) — there is no header or body path a caller could spoof.
 */
export interface AppOptions {
  identityExtractor?: (request: FastifyRequest) => string | undefined;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  // Never decorate 'awsLambda' here — @fastify/aws-lambda decorates that exact name at
  // wrap time, and a duplicate throws FST_ERR_DEC_ALREADY_PRESENT only in the deployed
  // lambda, never in tests.
  app.decorateRequest('userId', '');
  // API Gateway's $default route forwards even CORS preflights to this Lambda (documented
  // HTTP API gotcha: a catch-all route wins over automatic preflight handling), so answer
  // them OK — the gateway appends the Access-Control-* headers itself. Browsers require
  // an ok status here; a 404 blocks every cross-origin call before it starts.
  app.options('*', async (_request, reply) => reply.code(204).send());
  // Root-context hook so every route plugin inherits it. OPTIONS is exempt (preflights
  // carry no Authorization and must keep reaching the 204 catch-all above); /health is
  // exempt for probes — it is also the one route the gateway leaves unauthorized.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url.split('?')[0] === '/health') return;
    const userId = (opts.identityExtractor ?? lambdaJwtIdentity)(request);
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });
    request.userId = userId;
  });
  app.register(healthRoutes);
  app.register(resumeRoutes);
  app.register(runsRoutes);
  app.register(matchesRoutes);
  app.register(quotaRoutes);
  return app;
}
