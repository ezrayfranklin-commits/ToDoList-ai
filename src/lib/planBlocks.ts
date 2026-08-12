// 计划时间块插入（DB 直读直写版）。
//
// 背景（v0.8.1 bug）：原实现用组件闭包里的 plan 快照拼块，agent 一轮循环内
// 连续 add_task 时互相覆盖，导致几十个带时间任务只留下最后 1 个块。
// 本模块每次从 SQLite 读取最新 daily_plans，追加后写回；今日无计划时
// 自动创建 draft 计划——保证「今天 + 带时间」的任务一定进入今日规划时间块。

import { getDb } from "@/lib/db";
import { todayStr } from "@/lib/dates";
import type { DailyPlanData, TimeBlock } from "@/lib/types";

/** 从 DB 读取今日计划（最新数据，不走查询缓存）。 */
async function readTodayPlan(dateStr: string): Promise<{
  id: number;
  data: DailyPlanData;
} | null> {
  const db = getDb();
  const rows = (await db.select<Array<Record<string, unknown>>>(
    "SELECT id, data FROM daily_plans WHERE plan_date = $1",
    [dateStr],
  )) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const id = Number(rows[0].id);
  let data: DailyPlanData | null = null;
  try {
    data = rows[0].data ? (JSON.parse(String(rows[0].data)) as DailyPlanData) : null;
  } catch {
    data = null;
  }
  return { id, data: data ?? { date: dateStr, timeBlocks: [], notes: "" } };
}

/**
 * 把时间块插入（或更新）今日计划：有则追加并排序，无则创建 draft 计划。
 * 返回插入后的时间块列表。
 */
export async function upsertTodayPlanBlock(
  block: TimeBlock,
  dateStr = todayStr(),
): Promise<TimeBlock[]> {
  const db = getDb();
  const plan = await readTodayPlan(dateStr);
  const existing = plan?.data.timeBlocks ?? [];
  // 同 taskId 已存在 → 原位更新（时间可能变了）；否则追加
  const idx = existing.findIndex(
    (b) => block.taskId != null && b.taskId === block.taskId,
  );
  let next: TimeBlock[];
  if (idx >= 0) {
    next = existing.map((b, i) => (i === idx ? block : b));
  } else {
    next = [...existing, block];
  }
  next.sort((a, b) => a.start.localeCompare(b.start));

  const data: DailyPlanData = {
    date: dateStr,
    timeBlocks: next,
    notes: plan?.data.notes ?? "",
    inboxActions: plan?.data.inboxActions ?? [],
  };
  if (plan) {
    await db.execute(
      `UPDATE daily_plans SET data = $1, updated_at = datetime('now') WHERE id = $2`,
      [JSON.stringify(data), plan.id],
    );
  } else {
    await db.execute(
      `INSERT INTO daily_plans (plan_date, data, status, source) VALUES ($1, $2, 'draft', 'manual')`,
      [dateStr, JSON.stringify(data)],
    );
  }
  return next;
}

/**
 * 合并 AI 生成的计划块与今日已有带时间任务（v0.8.4 修复）。
 * 「一键规划」不得覆盖/丢失用户已有的带时间任务块：
 * AI 块优先（含其排期调整），任务表中带时间的未完成任务全部并入，
 * 旧计划中已完成的块保留（不丢完成记录），最后按时间排序。
 */
export async function mergeAiBlocksWithTasks(
  aiBlocks: TimeBlock[],
  dateStr: string,
  preserveDone?: TimeBlock[],
): Promise<TimeBlock[]> {
  const db = getDb();
  const rows = (await db.select<Array<Record<string, unknown>>>(
    `SELECT id, title, priority, time_block_start, time_block_end FROM tasks
     WHERE status = 'scheduled' AND scheduled_date = $1
       AND time_block_start IS NOT NULL AND time_block_end IS NOT NULL`,
    [dateStr],
  )) as unknown as Array<Record<string, unknown>>;

  const merged: TimeBlock[] = [...aiBlocks];
  const seen = new Set<number>();
  for (const b of merged) {
    if (b.taskId != null) seen.add(b.taskId);
  }
  // 旧计划里已完成的块（AI 重新生成时保留完成记录）
  for (const b of preserveDone ?? []) {
    if (!b.done) continue;
    if (b.taskId != null && seen.has(b.taskId)) continue;
    merged.push(b);
    if (b.taskId != null) seen.add(b.taskId);
  }
  // 任务表中今天带时间的任务
  for (const r of rows) {
    const taskId = Number(r.id);
    if (seen.has(taskId)) continue;
    merged.push({
      key: `task:${taskId}`,
      title: String(r.title),
      start: String(r.time_block_start),
      end: String(r.time_block_end),
      priority: (r.priority as TimeBlock["priority"]) ?? "medium",
      effort: "",
      taskId,
      done: false,
    });
    seen.add(taskId);
  }
  merged.sort((a, b) => a.start.localeCompare(b.start));
  return merged;
}

/** 一次性把某天所有「带时间的今日任务」合并进当日计划（存量数据迁移用）。 */
export async function rebuildPlanFromTasks(
  dateStr = todayStr(),
): Promise<number> {
  const db = getDb();
  const rows = (await db.select<Array<Record<string, unknown>>>(
    `SELECT id, title, priority, time_block_start, time_block_end FROM tasks
     WHERE status = 'scheduled' AND scheduled_date = $1
       AND time_block_start IS NOT NULL AND time_block_end IS NOT NULL
     ORDER BY time_block_start ASC`,
    [dateStr],
  )) as unknown as Array<Record<string, unknown>>;

  const plan = await readTodayPlan(dateStr);
  const planBlocks = plan?.data.timeBlocks ?? [];
  const taskIdsInPlan = new Set(
    planBlocks.map((b) => b.taskId).filter((x): x is number => x != null),
  );
  const fromTasks: TimeBlock[] = rows.map((r, i) => {
    const taskId = Number(r.id);
    const priority = (r.priority as TimeBlock["priority"]) ?? "medium";
    return {
      key: `task:${taskId}`,
      title: String(r.title),
      start: String(r.time_block_start),
      end: String(r.time_block_end),
      priority,
      effort: "",
      taskId,
      done: false,
    };
  });
  // 保留计划里已有块（含已完成的），加上任务表中的块，按 taskId 去重
  const merged = [...planBlocks];
  for (const b of fromTasks) {
    if (b.taskId != null && taskIdsInPlan.has(b.taskId)) continue;
    merged.push(b);
  }
  merged.sort((a, b) => a.start.localeCompare(b.start));

  const data: DailyPlanData = {
    date: dateStr,
    timeBlocks: merged,
    notes: plan?.data.notes ?? "",
    inboxActions: plan?.data.inboxActions ?? [],
  };
  if (plan) {
    await db.execute(
      `UPDATE daily_plans SET data = $1, updated_at = datetime('now') WHERE id = $2`,
      [JSON.stringify(data), plan.id],
    );
  } else if (merged.length > 0) {
    await db.execute(
      `INSERT INTO daily_plans (plan_date, data, status, source) VALUES ($1, $2, 'draft', 'manual')`,
      [dateStr, JSON.stringify(data)],
    );
  }
  return merged.length;
}
