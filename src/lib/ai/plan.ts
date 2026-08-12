// Planning agent: structured daily plan generation (design doc §4.2).
// Plan-and-Execute, 确认环节: generation only writes a draft; the UI shows it
// and the user confirms/edits before `applyPlanToDb` mutates tasks.

import { generateObject } from "ai";
import { getDb } from "@/lib/db";
import { getModel } from "@/lib/ai/provider";
import { generateStructured } from "@/lib/ai/ollama";
import {
  PLANNER_SYSTEM,
  dailyPlanSchema,
  type DailyPlanOutput,
} from "@/lib/ai/schemas";

export type { DailyPlanOutput } from "@/lib/ai/schemas";
import type {
  AISettings,
  DailyPlan,
  DailyPlanData,
  PlanContext,
  Priority,
  TimeBlock,
} from "@/lib/types";
import { todayStr, tomorrowStr } from "@/lib/dates";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateDailyPlan(
  ctx: PlanContext,
  settings: AISettings,
): Promise<DailyPlanOutput> {
  const prompt = `今日上下文 JSON：\n${JSON.stringify(ctx, null, 2)}\n\n请生成今日计划。`;
  if (settings.provider === "ollama") {
    // Ollama ignores AI SDK's response_format schema; use the direct
    // tool-call generator with validation + retry (lib/ai/ollama.ts).
    return generateStructured({
      settings,
      system: PLANNER_SYSTEM,
      prompt,
      schema: dailyPlanSchema,
      temperature: 0.4,
    });
  }
  const { object } = await generateObject({
    model: getModel(settings),
    schema: dailyPlanSchema,
    system: PLANNER_SYSTEM,
    prompt,
    temperature: 0.4,
  });
  return object;
}

// ---------------------------------------------------------------------------
// Workflow: draft → confirm (write tasks) → log
// ---------------------------------------------------------------------------

function keyFor(taskId: number, title: string, i: number): string {
  return taskId > 0 ? `task:${taskId}` : `new:${i}:${title}`;
}

/** Persist a generated plan as a draft row (no task mutation yet). */
export async function savePlanDraft(
  dateStr: string,
  output: DailyPlanOutput,
  model: string | null,
  ctx: PlanContext,
): Promise<DailyPlan> {
  const db = getDb();
  const data: DailyPlanData = {
    date: dateStr,
    timeBlocks: output.timeBlocks.map((tb, i) => ({
      key: keyFor(tb.taskId, tb.title, i),
      title: tb.title,
      start: tb.start,
      end: tb.end,
      priority: tb.priority,
      effort: tb.effort,
      taskId: tb.taskId > 0 ? tb.taskId : null,
      done: false,
    })),
    notes: output.notes ?? "",
    inboxActions: output.inboxActions,
  };
  const existing = await getPlanByDate(dateStr);
  if (existing) {
    await db.execute(
      `UPDATE daily_plans SET data = $1, status = 'draft', source = 'agent', updated_at = datetime('now') WHERE id = $2`,
      [JSON.stringify(data), existing.id],
    );
    await logRun("plan", model, "ok", ctx, output, null, null);
    return { ...existing, data, status: "draft" as const };
  }
  const result = await db.execute(
    `INSERT INTO daily_plans (plan_date, data, status, source) VALUES ($1, $2, 'draft', 'agent')`,
    [dateStr, JSON.stringify(data)],
  );
  const id = Number(result.lastInsertId ?? 0);
  await logRun("plan", model, "ok", ctx, output, null, null);
  return {
    id,
    planDate: dateStr,
    data,
    status: "draft",
    summary: null,
    source: "agent",
    createdAt: "",
    updatedAt: "",
  };
}

/** Apply a (possibly user-edited) plan to the tasks table. */
export async function applyPlanToDb(plan: DailyPlan): Promise<void> {
  if (!plan.data) return;
  const db = getDb();
  const dateStr = plan.data.date;
  const blocks = plan.data.timeBlocks;

  // 1) upsert tasks referenced by blocks; new blocks create tasks
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.taskId != null) {
      await db.execute(
        `UPDATE tasks SET
           title = $1, priority = $2, status = 'scheduled',
           scheduled_date = $3, time_block_start = $4, time_block_end = $5,
           order_index = $6, updated_at = datetime('now')
         WHERE id = $7`,
        [b.title, b.priority, dateStr, b.start, b.end, i, b.taskId],
      );
    } else {
      const res = await db.execute(
        `INSERT INTO tasks (title, priority, status, scheduled_date, time_block_start, time_block_end, order_index, source)
         VALUES ($1, $2, 'scheduled', $3, $4, $5, $6, 'agent')`,
        [b.title, b.priority, dateStr, b.start, b.end, i],
      );
      b.taskId = Number(res.lastInsertId);
      b.key = `task:${b.taskId}`;
    }
  }

  // 2) inboxActions
  for (const act of plan.data.inboxActions ?? []) {
    if (act.action === "schedule") {
      await db.execute(
        `UPDATE tasks SET status = 'scheduled', scheduled_date = $1, updated_at = datetime('now') WHERE id = $2`,
        [dateStr, act.taskId],
      );
    } else if (act.action === "defer") {
      await db.execute(
        `UPDATE tasks SET status = 'scheduled', scheduled_date = $1, source = 'carried', updated_at = datetime('now') WHERE id = $2`,
        [tomorrowStr(), act.taskId],
      );
    } else if (act.action === "drop") {
      await db.execute(
        `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = $2`,
        [act.taskId],
      );
    }
  }

  // 3) mark plan confirmed
  await db.execute(
    `UPDATE daily_plans SET data = $1, status = 'confirmed', updated_at = datetime('now') WHERE id = $2`,
    [JSON.stringify(plan.data), plan.id],
  );
}

export async function getPlanByDate(
  dateStr: string,
): Promise<DailyPlan | null> {
  const db = getDb();
  const rows = (await db.select<Array<Record<string, unknown>>>(
    "SELECT * FROM daily_plans WHERE plan_date = $1",
    [dateStr],
  )) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  return rowToPlan(rows[0]);
}

export async function listRecentPlans(limit = 14): Promise<DailyPlan[]> {
  const db = getDb();
  const rows = (await db.select<Array<Record<string, unknown>>>(
    "SELECT * FROM daily_plans ORDER BY plan_date DESC LIMIT $1",
    [limit],
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToPlan);
}

function rowToPlan(r: Record<string, unknown>): DailyPlan {
  let data: DailyPlanData | null = null;
  try {
    data = r.data ? (JSON.parse(String(r.data)) as DailyPlanData) : null;
  } catch {
    data = null;
  }
  return {
    id: Number(r.id),
    planDate: String(r.plan_date),
    data,
    status: (r.status as DailyPlan["status"]) ?? "draft",
    summary: r.summary ? String(r.summary) : null,
    source: String(r.source ?? "agent"),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function logRun(
  runType: "plan" | "review" | "chat",
  model: string | null,
  status: "ok" | "error",
  ctx: PlanContext | unknown,
  result: unknown,
  feedback: string | null,
  error: string | null,
): Promise<void> {
  const db = getDb();
  await db.execute(
    `INSERT INTO agent_runs (run_type, model, status, context, result, feedback, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      runType,
      model,
      status,
      ctx ? JSON.stringify(ctx) : null,
      result ? JSON.stringify(result) : null,
      feedback,
      error,
    ],
  );
}

export function priorityRank(p: Priority): number {
  return p === "high" ? 0 : p === "medium" ? 1 : 2;
}

export const planDoneCount = (plan: DailyPlan): number =>
  plan.data?.timeBlocks.filter((b) => b.done).length ?? 0;

export const planTotalCount = (plan: DailyPlan): number =>
  plan.data?.timeBlocks.length ?? 0;

export const planProgress = (plan: DailyPlan): number => {
  const total = planTotalCount(plan);
  return total === 0 ? 0 : Math.round((planDoneCount(plan) / total) * 100);
};

export const todayKey = (): string => todayStr();
