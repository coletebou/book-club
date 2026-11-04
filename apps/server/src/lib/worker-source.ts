import { fileURLToPath } from 'node:url';
import type * as Esbuild from 'esbuild';

const bundles = new Map<string, Promise<string>>();

/**
 * A worker's script bundled from the sources (tsx in development, vitest), once per process and
 * file, as the production build bundles it (build.mjs: an ES module, its CommonJS dependencies
 * given `require`). Node cannot run it as it is: the workspace packages it imports are TypeScript
 * whose imports name no file extensions. esbuild is a development dependency, which the built
 * server never asks for: it uses the bundles build.mjs wrote beside it.
 */
export function workerFromSources(entry: URL): Promise<string> {
  const key = entry.href;
  let bundle = bundles.get(key);
  if (!bundle) {
    bundle = (async () => {
      // Named through a variable, so that the production build leaves esbuild out of the bundle.
      const name = 'esbuild';
      const esbuild = (await import(name)) as typeof Esbuild;
      const out = await esbuild.build({
        entryPoints: [fileURLToPath(entry)],
        // Everything in it, so that it runs as the worker's script with nothing outside it to find.
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        banner: { js: "import { createRequire as __bcCreateRequire } from 'node:module'; const require = __bcCreateRequire(import.meta.url);" },
        logLevel: 'silent',
      });
      return out.outputFiles[0]!.text;
    })();
    bundles.set(key, bundle);
    // A failed bundling is tried again by the next worker.
    bundle.catch(() => bundles.delete(key));
  }
  return bundle;
}
