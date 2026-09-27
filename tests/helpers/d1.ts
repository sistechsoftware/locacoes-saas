/**
 * Adaptador D1 sobre o SQLite embutido do Node.
 *
 * Permite exercitar exatamente as mesmas consultas SQL da aplicacao nos testes,
 * sem subir infraestrutura Cloudflare. So implementa a superficie do D1 que o
 * projeto usa (prepare/bind/all/first/run/batch).
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: any[] = [],
  ) {}

  bind(...params: any[]) {
    return new Stmt(this.db, this.sql, params);
  }

  async all<T = any>() {
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results, success: true, meta: {} };
  }

  async first<T = any>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row ?? null) as T | null;
  }

  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes), rows_written: Number(r.changes) },
    };
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string) {
    return new Stmt(this.sqlite, sql);
  }

  async batch(statements: any[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/** Cria um banco novo com todas as migrations aplicadas e o injeta em getDb(). */
export function createTestDb(): FakeD1 {
  const db = new FakeD1();
  const dir = path.join(ROOT, "migrations");
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    db.sqlite.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  (globalThis as any).__limasTestDb = db;
  return db;
}

export function resetTestDb() {
  (globalThis as any).__limasTestDb = undefined;
}
