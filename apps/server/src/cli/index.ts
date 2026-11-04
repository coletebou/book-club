#!/usr/bin/env node
/*
 * bookclub CLI: operational tasks on a data directory.
 *
 *   bookclub seed                         seed the demo club on an empty database
 *   bookclub create-owner --email E --name N (--password P | --password-stdin) [--club NAME]
 *   bookclub reset-link --email E [--origin URL]   one-time password reset link
 *   bookclub backup [--out FILE]          consistent backup (database + files) to a .tar.gz
 *   bookclub backup --set DIR [--keep N]  incremental backup: a dated snapshot in DIR, pruned to
 *                                         the newest N (14 default); see cli/backup-set.ts (D125)
 *   bookclub restore --from FILE [--force]       restore a single-file backup (server stopped)
 *   bookclub restore --from-set DIR [--at TS] [--force]   restore an incremental set's newest
 *                                         snapshot, or its newest at or before UTC timestamp TS
 *   bookclub prune --set DIR [--keep N]   prune an incremental set on its own (e.g. after lowering
 *                                         --keep); `backup --set` already does this each run
 *   bookclub deleted                      disbanded clubs and removed books, still recoverable (D179)
 *   bookclub undelete (--club ID | --book ID)  bring a disbanded club or a removed book back
 *   bookclub purge (--club ID | --book ID)     remove a disbanded club or a removed book for good
 *
 * `--password-stdin` reads the password from a pipe or a file (`--password-stdin < FILE`), so it
 * is neither on the command line, where every user of the host can read it, nor in a shell's
 * history. DATA_DIR and the other settings come from the environment, as for the server.
 */
import { parseArgs } from 'node:util';
import { SetupBodySchema } from '@bookclub/shared';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { hashPassword } from '../lib/crypto';
import { createClub } from '../repos/clubs';
import { issueResetLink } from '../repos/resets';
import { createLocalUser, userByEmail } from '../repos/users';
import { backup, restore } from './backup';
import { backupSet, pruneSet, restoreSet } from './backup-set';
import { seedDemoIfEmpty } from './seed';
import { listDeleted, purgeBook, purgeClub, undelete } from '../services/removal';

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      'password-stdin': { type: 'boolean' },
      club: { type: 'string' },
      book: { type: 'string' },
      origin: { type: 'string' },
      out: { type: 'string' },
      from: { type: 'string' },
      'from-set': { type: 'string' },
      set: { type: 'string' },
      keep: { type: 'string' },
      at: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const config = loadConfig();

  if (command === 'backup') {
    if (values.set) {
      const keep = values.keep !== undefined ? Number(values.keep) : undefined;
      if (keep !== undefined && !(Number.isInteger(keep) && keep > 0)) throw new Error('--keep needs a positive whole number');
      const result = await backupSet(config.dataDir, values.set, { keep });
      console.log(
        `backup set updated: ${result.dir} (snapshot ${result.dbFile}, ${result.dbBytes} bytes; ` +
          `${result.blobsCopied} of ${result.blobsTotal} file(s) copied, ${result.pubsCopied} of ${result.pubsTotal} publication file(s) copied; ` +
          `pruned ${result.pruned.snapshotsRemoved} old snapshot(s), freed ${result.pruned.filesRemoved} file(s), ${result.pruned.bytesFreed} bytes)`,
      );
      return 0;
    }
    const out = values.out ?? `bookclub-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const result = await backup(config.dataDir, out);
    console.log(`backup written: ${result.file} (${result.bytes} bytes)`);
    return 0;
  }
  if (command === 'restore') {
    if (values['from-set']) {
      const result = await restoreSet(values['from-set'], config.dataDir, { at: values.at, force: values.force ?? false });
      console.log(`restored ${values['from-set']} (snapshot ${result.dbFile}) into ${config.dataDir}`);
      return 0;
    }
    if (!values.from) throw new Error('restore needs --from FILE or --from-set DIR');
    await restore(values.from, config.dataDir, { force: values.force ?? false });
    console.log(`restored ${values.from} into ${config.dataDir}`);
    return 0;
  }
  if (command === 'prune') {
    if (!values.set) throw new Error('prune needs --set DIR');
    const keep = values.keep !== undefined ? Number(values.keep) : 14;
    if (!(Number.isInteger(keep) && keep > 0)) throw new Error('--keep needs a positive whole number');
    const result = await pruneSet(values.set, keep);
    console.log(`pruned ${result.snapshotsRemoved} old snapshot(s) from ${values.set}: ${result.filesRemoved} file(s) freed, ${result.bytesFreed} bytes`);
    return 0;
  }

  const { ctx, close } = await buildApp({ config, logger: { level: 'warn' }, background: false });
  try {
    switch (command) {
      case 'seed': {
        const seeded = await seedDemoIfEmpty(ctx);
        console.log(seeded ? 'demo club seeded' : 'database not empty (or demo assets missing): nothing to do');
        return 0;
      }
      case 'create-owner': {
        if (values.password !== undefined && values['password-stdin']) throw new Error('create-owner takes --password or --password-stdin, not both');
        const password = values['password-stdin'] ? await passwordFromStdin() : values.password;
        if (!values.email || !values.name || !password) throw new Error('create-owner needs --email, --name and --password (or --password-stdin)');
        // What the setup page would accept, so the owner's password is held to the app's own rule.
        const parsed = SetupBodySchema.safeParse({ displayName: values.name, email: values.email, password, clubName: values.club || undefined });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(`${OWNER_FLAGS[String(issue?.path[0])] ?? 'create-owner'}: ${issue?.message ?? 'not accepted'}`);
        }
        const body = parsed.data;
        if (userByEmail(ctx.db, body.email)) throw new Error('a user with that email exists');
        const user = createLocalUser(ctx.db, { displayName: body.displayName, email: body.email, passwordHash: await hashPassword(body.password) });
        if (body.clubName) createClub(ctx.db, { name: body.clubName, description: '', ownerId: user.id });
        console.log(`created ${user.email}${body.clubName ? ` with club "${body.clubName}"` : ''}`);
        return 0;
      }
      case 'reset-link': {
        if (!values.email) throw new Error('reset-link needs --email');
        const user = userByEmail(ctx.db, values.email);
        if (!user) throw new Error('no user with that email');
        // Made by the server's admin: recorded as the person's own, so no club check applies.
        const { token } = issueResetLink(ctx.db, user.id, user.id);
        const origin = (values.origin ?? config.PUBLIC_ORIGIN ?? `http://${config.HOST}:${config.PORT}`).replace(/\/$/, '');
        console.log(`${origin}/reset/${token}`);
        return 0;
      }
      case 'deleted': {
        const rows = listDeleted(ctx.db);
        if (!rows.length) console.log('nothing deleted');
        for (const r of rows) console.log(`${r.kind}\t${r.id}\t${new Date(r.deletedAt).toISOString()}\tby ${r.deletedBy ?? '?'}\t${r.kind === 'book' ? `club ${r.clubId}\t` : ''}${r.name}`);
        return 0;
      }
      case 'undelete':
      case 'purge': {
        const target = deletedTarget(values.club, values.book, command);
        if (command === 'undelete') {
          if (!undelete(ctx, target.kind, target.id)) throw new Error(`no deleted ${target.kind} ${target.id}`);
          console.log(`${target.kind} ${target.id} is back`);
          return 0;
        }
        // Only what was deleted in the app first: a live club or book is never purged from here.
        if (!listDeleted(ctx.db).some((r) => r.kind === target.kind && r.id === target.id)) throw new Error(`no deleted ${target.kind} ${target.id} (only a disbanded club or a removed book can be purged)`);
        await (target.kind === 'club' ? purgeClub(ctx, target.id) : purgeBook(ctx, target.id));
        console.log(`${target.kind} ${target.id} purged`);
        return 0;
      }
      default:
        console.error('usage: bookclub <seed|create-owner|reset-link|backup|restore|prune|deleted|undelete|purge> [options]');
        return 2;
    }
  } finally {
    await close();
  }
}

function deletedTarget(club: string | undefined, book: string | undefined, command: string): { kind: 'club' | 'book'; id: string } {
  if (!!club === !!book) throw new Error(`${command} needs --club ID or --book ID (one of them)`);
  return club ? { kind: 'club', id: club } : { kind: 'book', id: book! };
}

/** The create-owner option behind each field of the setup body, for its error messages. */
const OWNER_FLAGS: Record<string, string> = { displayName: '--name', email: '--email', password: '--password', clubName: '--club' };

/** The password piped in, less one final line break. Not from a terminal, which would show it as it is typed. */
async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('--password-stdin reads a pipe or a file (with docker compose: exec -T), not a terminal');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
