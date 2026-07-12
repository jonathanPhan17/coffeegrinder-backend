import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

// Only browsers send CORS preflights, so nothing else in the suite (or curl testing)
// exercises OPTIONS — this pins the behavior the frontend cutover surfaced.
describe('CORS preflight', () => {
  it('answers OPTIONS on any route with 204 so the browser preflight passes', async () => {
    const app = buildApp();
    for (const url of ['/runs', '/matches/some-id', '/health']) {
      const res = await app.inject({ method: 'OPTIONS', url });
      expect(res.statusCode).toBe(204);
    }
    await app.close();
  });
});
