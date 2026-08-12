// 日历 CRUD Skill: 任务增删改查 (纯数据层, 无 React/AI 依赖).
// 与 AI 板块解耦: agent 工具 (src/lib/ai/tools.ts) 通过本模块操作任务,
// 保证任意日期的任务都能被定位/修改/删除, 消除"只能在今天查找"的结构性限制.

import { getDb } from "@/lib/db";
import { removePlanBlock } from "@/lib/planBlocks";
import type { Priority, Task } from "@/lib/types";

/** sqlx 返回 snake_case 行, 统一映射为 Task (与 queries.ts 的 toTask 一致). */
function toTask(row: Record<string, unknown>): Task {
  return {
    id: Number(row.id),
    title: String(row.title),
    notes: row.notes != null ? String(row.notes) : null,
    priority: (row.priority as Priority) ?? "medium",
    status: (row.status as Task["status"]) ?? "inbox",
    scheduledDate: row.scheduled_date != null ? String(row.scheduled_date) : null,
    timeBlockStart: row.time_block_start != null ? String(row.time_block_start) : null,
    timeBlockEnd: row.time_block_end != null ? String(row.time_block_end) : null,
    orderIndex: Number(row.order_index ?? 0),
    source: (row.source as Task["source"]) ?? "manual",
    completedAt: row.completed_at != null ? String(row.completed_at) : null,
    createdAt: row.created_at != null ? String(row.created_at) : "",
    updatedAt: row.updated_at != null ? String(row.updated_at) : "",
  };
}

/** 查找条件: 全库搜索, 不再局限于今天. */
export interface FindTaskOptions {
  /** 任务标题包含此关键词 (模糊匹配). */
  query: string;
  /** 限定日期 YYYY-MM-DD (可选). */
  date?: string | null;
  /** 限定状态 (可选): inbox | scheduled | done | cancelled. */
  status?: Task["status"] | null;
  /** 返回条数上限 (默认 10). */
  limit?: number;
}

/** 全库查找任务: 标题模糊 + 可选日期/状态过滤. 找不到返回空数组. */
export async function findTasks(opts: FindTaskOptions): Promise<Task[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (opts.query.trim()) {
    conds.push(`title LIKE $${vals.length + 1}`);
    vals.push(`%${opts.query.trim()}%`);
  }
  if (opts.date) {
    conds.push(`scheduled_date = $${vals.length + 1}`);
    vals.push(opts.date);
  }
  if (opts.status) {
    conds.push(`status = $${vals.length + 1}`);
    vals.push(opts.status);
  }
  const sql =
    conds.length > 0
      ? `SELECT * FROM tasks WHERE ${conds.join(" AND ")}
         ORDER BY
           CASE WHEN status = 'done' THEN 1 ELSE 0 END,
           scheduled_date IS NULL, scheduled_date ASC,
           time_block_start IS NULL, time_block_start ASC,
           id DESC
         LIMIT ${Math.min(Math.max(opts.limit ?? 10, 1), 50)}`
      : "SELECT * FROM tasks ORDER BY id DESC LIMIT 10";
  const rows = (await getDb().select<Array<Record<string, unknown>>>(
    sql,
    vals,
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(toTask);
}

/** 精确找一个任务: 优先精确标题, 其次包含匹配; 支持日期过滤. 返回 null 表示没找到或无法唯一确定. */
export async function findOneTask(
  title: string,
  opts: { date?: string | null; preferUndone?: boolean } = {},
): Promise<Task | null> {
  const q = title.trim();
  if (!q) return null;
  const candidates = await findTasks({ query: q, date: opts.date, limit: 20 });
  if (candidates.length === 0) return null;
  const pool = opts.preferUndone === false ? candidates : candidates.filter((t) => t.status !== "done");
  const usePool = pool.length > 0 ? pool : candidates;
  const exact = usePool.filter((t) => t.title === q);
  if (exact.length === 1) return exact[0];
  // 多个候选 (含完全同名) 且无日期限定: 无法唯一确定, 返回 null 让调用方反馈候选列表
  if (usePool.length > 1 && !opts.date) return null;
  return usePool[0] ?? null;
}

/** 查找候选列表 (供工具反馈给模型, 让模型带日期精确定位). */
export async function findTaskCandidates(
  title: string,
  opts: { date?: string | null; preferUndone?: boolean } = {},
): Promise<Task[]> {
  const q = title.trim();
  if (!q) return [];
  const candidates = await findTasks({ query: q, date: opts.date, limit: 20 });
  if (opts.preferUndone === false) return candidates;
  const pool = candidates.filter((t) => t.status !== "done");
  return pool.length > 0 ? pool : candidates;
}

/** 创建任务: 返回新任务的 id. */
export async function createTask(input: {
  title: string;
  notes?: string;
  priority?: Priority;
  status?: Task["status"];
  scheduledDate?: string | null;
  timeBlockStart?: string | null;
  timeBlockEnd?: string | null;
  source?: Task["source"];
}): Promise<number> {
  const db = getDb();
  const maxRes = (await db.select<Array<{ m: number | null }>>(
    "SELECT MAX(order_index) as m FROM tasks WHERE status = $1",
    [input.status ?? "inbox"],
  )) as unknown as Array<{ m: number | null }>;
  const nextOrder = (maxRes[0]?.m ?? 0) + 1;
  const res = await db.execute(
    `INSERT INTO tasks (title, notes, priority, status, scheduled_date, time_block_start, time_block_end, order_index, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.title,
      input.notes ?? null,
      input.priority ?? "medium",
      input.status ?? "inbox",
      input.scheduledDate ?? null,
      input.timeBlockStart ?? null,
      input.timeBlockEnd ?? null,
      nextOrder,
      input.source ?? "manual",
    ],
  );
  return Number(res.lastInsertId ?? 0);
}

/** 更新任务字段: 只更新传入的字段. */
export async function updateTask(
  id: number,
  patch: {
    title?: string;
    notes?: string | null;
    priority?: Priority;
    scheduledDate?: string | null;
    timeBlockStart?: string | null;
    timeBlockEnd?: string | null;
    status?: Task["status"];
  },
): Promise<void> {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const fields: Array<[string, unknown]> = [
    ["title", patch.title],
    ["notes", patch.notes],
    ["priority", patch.priority],
    ["scheduled_date", patch.scheduledDate],
    ["time_block_start", patch.timeBlockStart],
    ["time_block_end", patch.timeBlockEnd],
    ["status", patch.status],
  ];
  for (const [col, v] of fields) {
    if (v !== undefined) {
      sets.push(`${col} = $${sets.length + 1}`);
      vals.push(v);
    }
  }
  if (patch.status === "done") {
    sets.push(`completed_at = datetime('now')`);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  await db.execute(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

/** 删除任务: 删除后联动清理对应日期的计划块 (避免残留空计划圆点). */
export async function deleteTask(id: number): Promise<void> {
  const db = getDb();
  const rows = (await db.select<Array<{ scheduled_date: string | null }>>(
    "SELECT scheduled_date FROM tasks WHERE id = $1",
    [id],
  )) as unknown as Array<{ scheduled_date: string | null }>;
  await db.execute("DELETE FROM tasks WHERE id = $1", [id]);
  const date = rows[0]?.scheduled_date;
  if (date) await removePlanBlock(date, id);
}

/** 删除后校验: 确认任务真的不在了 (防谎报). */
export async function verifyTaskGone(id: number): Promise<boolean> {
  const rows = (await getDb().select<Array<{ c: number }>>(
    "SELECT COUNT(*) as c FROM tasks WHERE id = $1",
    [id],
  )) as unknown as Array<{ c: number }>;
  return (rows[0]?.c ?? 0) === 0;
}

/**
 * 批量删除: 按标题关键词 + 可选日期范围/状态, 删除全部命中任务.
 * 返回已删任务列表 (供工具转述), 每个删除都联动清理计划块.
 * 上限防误删: 超过 limit 条时不做任何删除, 返回 null 让调用方确认范围.
 */
export async function deleteTasksByQuery(
  query: string,
  opts: {
    date?: string | null;
    dateTo?: string | null;
    status?: Task["status"] | null;
    limit?: number;
  } = {},
): Promise<{ deleted: Task[]; remaining: Task[] } | null> {
  const q = query.trim();
  if (!q) return { deleted: [], remaining: [] };
  const cap = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const conds: string[] = [];
  const vals: unknown[] = [];
  conds.push(`title LIKE $${vals.length + 1}`);
  vals.push(`%${q}%`);
  if (opts.date) {
    conds.push(`scheduled_date >= $${vals.length + 1}`);
    vals.push(opts.date);
  }
  if (opts.dateTo) {
    conds.push(`scheduled_date <= $${vals.length + 1}`);
    vals.push(opts.dateTo);
  }
  if (opts.status) {
    conds.push(`status = $${vals.length + 1}`);
    vals.push(opts.status);
  }
  const sql = `SELECT * FROM tasks WHERE ${conds.join(" AND ")}
    ORDER BY scheduled_date IS NULL, scheduled_date ASC, time_block_start IS NULL, time_block_start ASC, id ASC`;
  const rows = (await getDb().select<Array<Record<string, unknown>>>(
    sql,
    vals,
  )) as unknown as Array<Record<string, unknown>>;
  const all = rows.map(toTask);
  if (all.length > cap) return null; // 超过上限: 不删除, 交由调用方确认范围
  const deleted: Task[] = [];
  for (const t of all) {
    await deleteTask(t.id);
    deleted.push(t);
  }
  // 删除后复核: 确认全部消失 (防谎报)
  const leftRows = (await getDb().select<Array<Record<string, unknown>>>(
    sql,
    vals,
  )) as unknown as Array<Record<string, unknown>>;
  const remaining = leftRows.map(toTask);
  return { deleted, remaining };
}

/** 按 id 读取单个任务. */
export async function getTaskById(id: number): Promise<Task | null> {
  const rows = (await getDb().select<Array<Record<string, unknown>>>(
    "SELECT * FROM tasks WHERE id = $1",
    [id],
  )) as unknown as Array<Record<string, unknown>>;
  return rows.length > 0 ? toTask(rows[0]) : null;
}
