// 测试 shim: 替代 @tauri-apps/plugin-sql (Node 环境用 node:sqlite).
// 只实现 runAgentLoop / calendar skill 用到的接口: load/execute/select.

import { DatabaseSync } from "node:sqlite";

let conn: DatabaseSync | null = null;

/**
 * 把 tauri/sqlx 风格的 $N 位置参数规范化为 ? (node:sqlite 把 $N 当命名参数,
 * 位置参数数组无法匹配). 字符串字面量里的 $ 不受影响 (项目 SQL 无此类情况).
 */
function normalize(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

/** 建表 (与 drizzle 0000 migration 一致, 测试库最小集). */
export function setupSchema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      notes TEXT,
      priority TEXT DEFAULT 'medium' NOT NULL,
      status TEXT DEFAULT 'inbox' NOT NULL,
      scheduled_date TEXT,
      time_block_start TEXT,
      time_block_end TEXT,
      order_index INTEGER DEFAULT 0 NOT NULL,
      source TEXT DEFAULT 'manual' NOT NULL,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_date TEXT NOT NULL,
      data TEXT,
      status TEXT DEFAULT 'draft' NOT NULL,
      summary TEXT,
      source TEXT DEFAULT 'agent' NOT NULL,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS daily_plans_date_idx ON daily_plans (plan_date);
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      model TEXT,
      status TEXT DEFAULT 'ok' NOT NULL,
      context TEXT,
      result TEXT,
      feedback TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      target_date TEXT,
      archived INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '新对话' NOT NULL,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);
}

/** 打开测试库 (内存). */
export function openTestDb(): void {
  conn = new DatabaseSync(":memory:");
  setupSchema(conn);
}

/** 关闭测试库. */
export function closeTestDb(): void {
  conn?.close();
  conn = null;
}

/** 测试用 SQL 直查 (审核时独立核对, 不经过被测试的代码路径). */
export function query(sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  if (!conn) throw new Error("test db not open");
  const stmt = conn.prepare(normalize(sql));
  return stmt.all(...(params as Array<string | number | bigint | null>)) as Array<
    Record<string, unknown>
  >;
}

/** 测试用 SQL 直写 (seed / 清理). */
export function run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
  if (!conn) throw new Error("test db not open");
  const stmt = conn.prepare(normalize(sql));
  return stmt.run(...(params as Array<string | number | bigint | null>));
}

// --- 模拟 @tauri-apps/plugin-sql 的 Database 接口 -------------------------

export class Database {
  static async load(_name: string): Promise<Database> {
    return new Database();
  }
  async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number; lastInsertId: number | bigint }> {
    const { changes, lastInsertRowid } = run(sql, params);
    return { rowsAffected: changes, lastInsertId: lastInsertRowid };
  }
  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return query(sql, params) as unknown as T[];
  }
}
