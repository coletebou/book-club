import { parseArgs } from 'node:util';
import { describe, expect, it } from 'vitest';
import { joinDashedValues } from '../src/cli/args';

describe('the command line, read so an id may start with a dash', () => {
  const options = { club: { type: 'string' }, plan: { type: 'string' }, force: { type: 'boolean' }, out: { type: 'string', short: 'o' } } as const;
  const read = (args: string[]) => parseArgs({ args: joinDashedValues(args, options), options }).values;

  it('takes a string option’s value that starts with a dash as its value', () => {
    expect(joinDashedValues(['--club', '-x4Ab', '--plan', 'pro'], options)).toEqual(['--club=-x4Ab', '--plan', 'pro']);
    expect(read(['--club', '-x4Ab', '--plan', 'pro'])).toEqual({ club: '-x4Ab', plan: 'pro' });
    expect(read(['--club', '--x4Ab'])).toEqual({ club: '--x4Ab' });
    expect(read(['--club=-x4Ab'])).toEqual({ club: '-x4Ab' });
  });

  it('leaves everything else as it was, so a missing value still fails', () => {
    expect(joinDashedValues(['--club', 'abc', '--force', '-o', 'f'], options)).toEqual(['--club', 'abc', '--force', '-o', 'f']);
    expect(joinDashedValues(['--force', '-x'], options)).toEqual(['--force', '-x']);
    expect(joinDashedValues(['--club', '--plan', 'pro'], options)).toEqual(['--club', '--plan', 'pro']);
    expect(joinDashedValues(['--club', '-o', 'f'], options)).toEqual(['--club', '-o', 'f']);
    expect(joinDashedValues(['--club', '--plan=pro'], options)).toEqual(['--club', '--plan=pro']);
    expect(() => read(['--club', '--plan', 'pro'])).toThrow();
  });
});
