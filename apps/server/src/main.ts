import { buildApp } from './app';
import { loadConfig } from './config';
import { seedDemoIfEmpty } from './cli/seed';
import { killTranscriptions } from './services/readalong';

const config = loadConfig();
const { app, ctx, close } = await buildApp({ config });

if (config.SEED_DEMO) {
  try {
    const seeded = await seedDemoIfEmpty(ctx);
    if (seeded) app.log.info({ seeded }, 'demo club seeded');
  } catch (err) {
    app.log.error({ err }, 'demo seed failed');
  }
}

await app.listen({ host: config.HOST, port: config.PORT });

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Asked again while stopping (Ctrl-C twice): stop now, without waiting for what is left, and
    // without leaving a recogniser behind (its kill after the grace period would never come).
    if (closing) {
      app.log.warn({ signal }, 'stopping at once');
      killTranscriptions(ctx);
      process.exit(1);
    }
    closing = true;
    app.log.info({ signal }, 'shutting down');
    close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  });
}
