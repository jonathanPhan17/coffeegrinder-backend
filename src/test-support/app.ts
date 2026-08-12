import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

/** The identity route tests run under — assertions on user-scoped keys expect it. */
export const TEST_USER = 'test-user';

/**
 * buildApp with an injected fixed identity. Tests can only reach identity through the
 * identityExtractor seam — production identity comes from gateway-verified JWT claims,
 * which no test harness can mint — so this is the one sanctioned test entry point.
 */
export function buildTestApp(userId = TEST_USER): FastifyInstance {
  return buildApp({ identityExtractor: () => userId });
}
