// Orchestrator: high-level agent operations used by the UI and scheduler
// (一键规划 / 定时自动规划 / 晚间复盘). All persistence through SQLite.

import { getSetting } from "@/lib/db";
import { buildPlanContext } from "@/lib/ai/context";
import {
  generateDailyPlan,
  savePlanDraft,
  getPlanByDate,
  type DailyPlanOutput,
} from "@/lib/ai/plan";
import { runEveningReview } from "@/lib/ai/review";
import { notify } from "@/lib/notify";
import { todayStr } from "@/lib/dates";
import type { AISettings, DailyPlan } from "@/lib/types";

export async function loadAISettings(): Promise<AISettings> {
  const [provider, model, apiKey, baseUrl, autoPlan, notifications, carryOver, autoReview] =
    await Promise.all([
      getSetting<AISettings["provider"]>("ai.provider", "ollama"),
      getSetting<string>("ai.model", "qwen2.5:7b"),
      getSetting<string>("ai.apiKey", ""),
      getSetting<string>("ai.baseUrl", "http://localhost:11434/v1"),
      getSetting<boolean>("autoPlan", true),
      getSetting<boolean>("notifications", true),
      getSetting<boolean>("carryOver", true),
      getSetting<boolean>("autoReview", true),
    ]);
  return {
    provider,
    model,
    apiKey,
    baseUrl,
    autoPlan,
    notifications,
    carryOver,
    autoReview,
  };
}

export type PlanResult = {
  ok: boolean;
  plan?: DailyPlan;
  error?: string;
};

/**
 * Run the planning agent for a date and persist a DRAFT plan.
 * Nothing is written to tasks until the user confirms (规划 §4.1 确认环节).
 */
export async function runPlanning(
  dateStr = todayStr(),
  silent = false,
): Promise<PlanResult> {
  try {
    const settings = await loadAISettings();
    const ctx = await buildPlanContext(dateStr);
    const output: DailyPlanOutput = await generateDailyPlan(ctx, settings);
    const plan = await savePlanDraft(dateStr, output, settings.model, ctx);
    if (!silent) {
      await notify(
        "今日计划已生成 ✨",
        `${output.timeBlocks.length} 个时间块，请确认后开始执行`,
      );
    }
    return { ok: true, plan };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!silent) {
      await notify("规划失败", msg.slice(0, 200));
    }
    return { ok: false, error: msg };
  }
}

/** Evening review + carry-over. */
export async function runReview(
  dateStr = todayStr(),
  silent = false,
): Promise<{ ok: boolean; summary?: string; carried?: number; error?: string }> {
  try {
    const settings = await loadAISettings();
    const { summary, carried } = await runEveningReview(dateStr, settings);
    if (!silent) {
      await notify(
        "晚间复盘完成 🌙",
        `完成度已记录${carried > 0 ? `，${carried} 项任务顺延至明日` : ""}`,
      );
    }
    return { ok: true, summary, carried };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function planStatusFor(
  dateStr: string,
): Promise<DailyPlan | null> {
  return getPlanByDate(dateStr);
}
