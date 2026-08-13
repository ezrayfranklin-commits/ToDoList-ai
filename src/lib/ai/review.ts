// Evening review agent (design doc):
// summary of the day + auto-carry-over of uncompleted tasks to tomorrow.

import { generateText } from "ai";
import { getDb } from "@/lib/db";
import { getModel } from "@/lib/ai/provider";
import { generatePlainText } from "@/lib/ai/ollama";
import { getPlanByDate, logRun } from "@/lib/ai/plan";
import { tomorrowStr } from "@/lib/dates";
import type { AISettings, DailyPlan } from "@/lib/types";
import { lang } from "@/lib/i18n";

const REVIEW_SYSTEM = (): string =>
  (lang() === "en" ? "The user's UI is in English. Write the review in English.\n\n" : "") +
  `你是一名复盘教练。输入是用户某天的计划与执行情况 JSON。
输出一段简短的中文复盘（Markdown 格式，150 字以内）：
- 完成情况一句话总结
- 亮点 1 条（如有）
- 未完成原因归类（可做可不做 / 高估工作量 / 计划外插入 / 其他）
- 给明天的 1 条建议`;

interface ReviewInput {
  date: string;
  plan: DailyPlan | null;
  completed: Array<{ title: string; priority: string }>;
  uncompleted: Array<{ title: string; priority: string }>;
  carriedToTomorrow: number;
}

export async function runEveningReview(
  dateStr: string,
  settings: AISettings,
): Promise<{ summary: string; carried: number }> {
  const db = getDb();
  const plan = await getPlanByDate(dateStr);

  // Tasks completed today (regardless of plan)
  const completedRows = (await db.select<Array<Record<string, unknown>>>(
    `SELECT title, priority FROM tasks
     WHERE status = 'done' AND date(completed_at) = $1`,
    [dateStr],
  )) as unknown as Array<Record<string, unknown>>;

  // Tasks that were scheduled today but not completed
  const uncompletedRows = (await db.select<Array<Record<string, unknown>>>(
    `SELECT title, priority FROM tasks
     WHERE status = 'scheduled' AND scheduled_date = $1`,
    [dateStr],
  )) as unknown as Array<Record<string, unknown>>;

  const input: ReviewInput = {
    date: dateStr,
    plan,
    completed: completedRows.map((r) => ({
      title: String(r.title),
      priority: String(r.priority),
    })),
    uncompleted: uncompletedRows.map((r) => ({
      title: String(r.title),
      priority: String(r.priority),
    })),
    carriedToTomorrow: uncompletedRows.length,
  };

  let summary = "";
  let ok = false;
  let error: string | null = null;
  try {
    let text: string;
    if (settings.provider === "anthropic") {
      const res = await generateText({
        model: getModel(settings),
        system: REVIEW_SYSTEM(),
        prompt: `复盘输入 JSON：\n${JSON.stringify(input, null, 2)}`,
        temperature: 0.5,
      });
      text = res.text;
    } else {
      // OpenAI-compatible endpoints (incl. third-party gateways)
      text = await generatePlainText({
        settings,
        system: REVIEW_SYSTEM(),
        prompt: `复盘输入 JSON：\n${JSON.stringify(input, null, 2)}`,
        temperature: 0.5,
      });
    }
    summary = text.trim();
    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    summary = lang() === "en"
      ? `Completed ${completedRows.length} today, ${uncompletedRows.length} still open.`
      : `今天完成了 ${completedRows.length} 项，还有 ${uncompletedRows.length} 项未完成。`;
  }

  // Carry over uncompleted tasks to tomorrow (design doc)
  let carried = 0;
  if (settings.carryOver) {
    const tomorrow = tomorrowStr();
    const res = await db.execute(
      `UPDATE tasks
       SET scheduled_date = $1, source = 'carried', time_block_start = NULL, time_block_end = NULL,
           updated_at = datetime('now')
       WHERE status = 'scheduled' AND scheduled_date = $2`,
      [tomorrow, dateStr],
    );
    carried = res.rowsAffected;
  }

  if (plan) {
    await db.execute(
      `UPDATE daily_plans SET summary = $1, status = 'reviewed', updated_at = datetime('now') WHERE id = $2`,
      [summary, plan.id],
    );
  }

  await logRun("review", settings.model, ok ? "ok" : "error", input, { summary }, null, error);
  return { summary, carried };
}
