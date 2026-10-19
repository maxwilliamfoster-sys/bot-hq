// A D1-shaped wrapper over node:sqlite so Worker code can be tested locally.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function statement(sqlite, sql, args = []) {
  const prep = () => sqlite.prepare(sql);
  return {
    bind: (...a) => statement(sqlite, sql, a.map(v => (v === undefined ? null : v))),
    async first(col) {
      const row = prep().get(...args);
      if (!row) return null;
      return col ? row[col] : { ...row };
    },
    async all() {
      return { results: prep().all(...args).map(r => ({ ...r })) };
    },
    async run() {
      const r = prep().run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec() {
      return prep().run(...args);
    },
  };
}

export function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return {
    prepare: sql => statement(sqlite, sql),
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}
