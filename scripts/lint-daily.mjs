// Typed ESLint is deliberately outside the PR gate: retaining one TypeScript program per
// project across a monorepo OOMs the 1 GiB runner. Fresh, small, project-local batches bound it.
import { execFileSync, spawnSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => /\.(?:[cm]?js|tsx?)$/.test(file) && !file.startsWith('apps/mobile/'));
const groups = new Map();
for (const file of files) {
  const parts = file.split('/');
  const project = ['apps', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
  if (!groups.has(project)) groups.set(project, []);
  groups.get(project).push(file);
}
let failed = false;
for (const [project, members] of groups) {
  for (let start = 0; start < members.length; start += 8) {
    const batch = members.slice(start, start + 8);
    console.warn(`typed lint: ${project} ${start + 1}-${start + batch.length}/${members.length}`);
    const result = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--max-warnings=0', '--no-warn-ignored', ...batch], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=576' },
    });
    if (result.status !== 0) {
      failed = true;
      const why = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
      console.error(`typed lint: FAILED ${project} ${start + 1}-${start + batch.length} (${why}): ${batch.join(' ')}`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
