import { request } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE } from './api';

/** The suite runs against the real stack; fail fast and clearly when it is not up. */
export default async function globalSetup(): Promise<void> {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  try {
    const health = await ctx.get('/healthz');
    if (!health.ok()) throw new Error(`health check returned ${health.status()}`);
    const signin = await ctx.post('/api/auth/signin', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (!signin.ok()) throw new Error(`demo owner cannot sign in (${signin.status()}); is the demo stack seeded?`);
  } catch (err) {
    throw new Error(`Book Club is not reachable at ${BASE}. Start it with: docker compose up -d --build --wait\n${String(err)}`, { cause: err });
  } finally {
    await ctx.dispose();
  }
}
