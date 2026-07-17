// Database driver abstraction. The repository layer (index.ts) is written
// against this interface only, so SQLite (local/dev default) and Postgres
// (production, e.g. Neon/Supabase) are interchangeable behind it.
//
// Conventions shared by both drivers:
//  • positional `?` placeholders (translated to $1..$n for Postgres)
//  • timestamps are TEXT in UTC 'YYYY-MM-DD HH:MM:SS' (SQLite datetime style)
//  • counts come back as JS numbers (pg BIGINT is parsed)

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RunResult {
  changes: number;
}

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  /** SQL expression: current UTC time as 'YYYY-MM-DD HH:MM:SS'. */
  readonly nowSql: string;
  /** SQL condition: TEXT timestamp column falls on today's UTC date. */
  todayCond(col: string): string;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** INSERT into a table with an integer `id` PK; returns the new id. */
  insert(sql: string, params?: unknown[]): Promise<number>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// ── SQLite ───────────────────────────────────────────────────────────────────

export class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const;
  readonly nowSql = `datetime('now')`;
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
  }

  todayCond(col: string): string {
    return `date(${col}) = date('now')`;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const info = this.raw.prepare(sql).run(...params);
    return { changes: info.changes };
  }

  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const info = this.raw.prepare(sql).run(...params);
    return Number(info.lastInsertRowid);
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

// ── Postgres ─────────────────────────────────────────────────────────────────

type PgPool = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
};

/** Translate `?` placeholders to $1..$n (no `?` appears in our SQL literals). */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const;
  readonly nowSql = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')`;
  private pool: PgPool | null = null;

  constructor(private readonly url: string) {}

  todayCond(col: string): string {
    return `substr(${col}, 1, 10) = to_char((now() at time zone 'utc'), 'YYYY-MM-DD')`;
  }

  private async getPool(): Promise<PgPool> {
    if (this.pool) return this.pool;
    // Lazy import so SQLite-only installs never load pg.
    const pg = await import('pg');
    // BIGINT (int8) + NUMERIC come back as strings by default — parse them.
    pg.default.types.setTypeParser(20, (v: string) => Number(v));
    pg.default.types.setTypeParser(1700, (v: string) => Number(v));
    this.pool = new pg.default.Pool({ connectionString: this.url, max: 5 }) as unknown as PgPool;
    return this.pool;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const pool = await this.getPool();
    const r = await pool.query(toPgPlaceholders(sql), params);
    return { changes: r.rowCount ?? 0 };
  }

  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const pool = await this.getPool();
    const r = await pool.query(`${toPgPlaceholders(sql)} RETURNING id`, params);
    return Number((r.rows[0] as { id: number | string }).id);
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const pool = await this.getPool();
    const r = await pool.query(toPgPlaceholders(sql), params);
    return r.rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pool = await this.getPool();
    const r = await pool.query(toPgPlaceholders(sql), params);
    return r.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(sql);
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function sqlitePathFromUrl(url: string | undefined): string {
  const raw = url ?? 'sqlite:./data/storefront.db';
  const path = raw.replace(/^sqlite:/, '');
  if (path === ':memory:') return path;
  return resolve(process.cwd(), path);
}

export function openDb(url = process.env.DATABASE_URL): Driver {
  const raw = url ?? 'sqlite:./data/storefront.db';
  if (raw.startsWith('postgres://') || raw.startsWith('postgresql://')) {
    return new PostgresDriver(raw);
  }
  return new SqliteDriver(sqlitePathFromUrl(raw));
}
