/**
 * Thin wrapper over `@duckdb/node-api` giving the pipeline a single connection
 * with typed helpers. DuckDB is the pipeline's only database: raw source tables,
 * reconciled entities and the published query tables all live in one file that
 * can be rebuilt from the raw archives at any time.
 *
 * @module duckdb/client
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";

export type Row = Record<string, DuckDBValue>;

export class Db {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    readonly path: string,
  ) {}

  /** Open (creating if needed) the database at `dbPath`; `:memory:` is allowed. */
  static async open(dbPath: string): Promise<Db> {
    if (dbPath !== ":memory:") await mkdir(path.dirname(dbPath), { recursive: true });
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    return new Db(instance, conn, dbPath);
  }

  /** Execute a statement, optionally with positional `?` parameters. */
  async run(sql: string, params: DuckDBValue[] = []): Promise<void> {
    if (params.length === 0) {
      await this.conn.run(sql);
      return;
    }
    const stmt = await this.conn.prepare(sql);
    try {
      stmt.bind(params);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  /** Run a query and return all rows as plain objects. */
  async all<T extends Row = Row>(sql: string, params: DuckDBValue[] = []): Promise<T[]> {
    if (params.length === 0) {
      const reader = await this.conn.runAndReadAll(sql);
      return reader.getRowObjects() as T[];
    }
    const stmt = await this.conn.prepare(sql);
    try {
      stmt.bind(params);
      const reader = await stmt.runAndReadAll();
      return reader.getRowObjects() as T[];
    } finally {
      stmt.destroySync();
    }
  }

  /** Run a query expected to return a single row (or undefined). */
  async one<T extends Row = Row>(sql: string, params: DuckDBValue[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  /** Convenience: `SELECT count(*)` of a table or subquery alias. */
  async count(tableOrSubquery: string): Promise<number> {
    const row = await this.one<{ n: bigint | number }>(
      `SELECT count(*) AS n FROM ${tableOrSubquery}`,
    );
    return Number(row?.n ?? 0);
  }

  async tableExists(name: string): Promise<boolean> {
    const row = await this.one<{ n: bigint | number }>(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ?`,
      [name],
    );
    return Number(row?.n ?? 0) > 0;
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

/** SQL-escape a string literal (single quotes doubled). */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
