import { type ParseArgsConfig } from 'node:util';

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * The command line as `parseArgs` should read it: `--club -x4…` becomes `--club=-x4…`. Ids are
 * base64url (`newId`), so one in 64 starts with a dash, and `parseArgs` takes a value that starts
 * with one for a missing value ("Option '--club' argument is ambiguous"). Only a string option's
 * next argument is joined, and never one that is itself an option, so a forgotten value still fails.
 */
export function joinDashedValues(args: readonly string[], options: Options): string[] {
  const isOption = (arg: string): boolean => {
    if (arg === '-' || !arg.startsWith('-')) return false;
    if (arg === '--') return true;
    const name = arg.replace(/^--?/, '').split('=')[0]!;
    return arg.startsWith('--') ? name in options : Object.values(options).some((o) => o.short === name);
  };
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const name = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : null;
    if (name !== null && options[name]?.type === 'string' && next !== undefined && next.startsWith('-') && !isOption(next)) {
      out.push(`${arg}=${next}`);
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}
