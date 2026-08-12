// 测试 shim: 替代 @/lib/db (Node 环境内存库).
// 与 tests/shim/sql.ts 共用同一内存连接.

import { Database, openTestDb, query, run } from "./sql";

let db: Database | null = null;

export async function initDb(): Promise<void> {
  if (!db) {
    openTestDb();
    db = new Database();
  }
}

export function getDb(): Database {
  if (!db) throw new Error("test db not initialized");
  return db;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = query("SELECT value FROM settings WHERE key = $1", [key]);
  if (rows.length === 0 || rows[0].value == null) return fallback;
  try {
    return JSON.parse(String(rows[0].value)) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  run(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = query("SELECT key, value FROM settings") as Array<{
    key: string;
    value: string;
  }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}
