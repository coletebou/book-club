import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type Row = Record<string, unknown>;
export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * A thin wrapper over `node:sqlite`: prepared-statement cache, typed helpers and nested
 * transactions (savepoints). SQLite runs in WAL mode with foreign keys on.
 */
export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    // A deleted note's words are overwritten in the file, not left in a free page.
    this.raw.exec('PRAGMA secure_delete = ON');
  }

  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private run(sql: string, params: Params | undefined, op: 'get' | 'all' | 'run') {
    const s = this.stmt(sql);
    if (params === undefined) return s[op]();
    if (Array.isArray(params)) return s[op](...params);
    return s[op](params);
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    return this.run(sql, params, 'get') as T | undefined;
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    return this.run(sql, params, 'all') as T[];
  }

  exec(sql: string, params?: Params): { changes: number; lastInsertRowid: number | bigint } {
    return this.run(sql, params, 'run') as { changes: number; lastInsertRowid: number | bigint };
  }

  /** Run `fn` atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth++;
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.depth--;
      this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
    this.depth--;
    try {
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
    } catch (err) {
      // A COMMIT that fails leaves the transaction open: end it, so the next one can begin.
      if (outer) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          // already ended
        }
      }
      throw err;
    }
    return result;
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number.parseInt(f.slice(0, 3), 10), name: f, sql: readFileSync(path.join(dir, f), 'utf8') }));
}

/** Apply migrations newer than `PRAGMA user_version`, each in its own transaction. */
export function migrate(db: Db, migrations: readonly Migration[] = loadMigrations()): number[] {
  const current = Number((db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0));
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.tx(() => {
      db.raw.exec(m.sql);
      db.raw.exec(`PRAGMA user_version = ${m.version}`);
    });
    applied.push(m.version);
  }
  return applied;
}

export function openDb(file: string): Db {
  const db = new Db(file);
  migrate(db);
  return db;
}
