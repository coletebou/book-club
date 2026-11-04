// Bundle the server (and the workspace packages it uses) into dist/; npm dependencies stay
// external and are installed by `pnpm deploy` in the Docker image.
import { cp, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
// The server's own npm dependencies stay external (installed by `pnpm deploy`, which puts only
// those at the top of node_modules). Workspace packages and their pure-JS dependencies are bundled.
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@bookclub/'));

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });
await build({
  // The worker threads (the track reader's, the aligner's) are files of their own, which the
  // bundles start beside them.
  entryPoints: {
    main: 'src/main.ts',
    cli: 'src/cli/index.ts',
    'track-worker': 'src/ingest/track-worker.ts',
    'align-worker': 'src/services/align-worker.ts',
    'vector-worker': 'src/cal/vector-worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  outExtension: { '.js': '.mjs' },
  external: [...new Set(external)].flatMap((d) => [d, `${d}/*`]),
  banner: { js: "import { createRequire as __bcCreateRequire } from 'node:module'; const require = __bcCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
await cp(new URL('./src/db/migrations', import.meta.url), new URL('./dist/migrations', import.meta.url), { recursive: true });
console.log('server bundle ready');
