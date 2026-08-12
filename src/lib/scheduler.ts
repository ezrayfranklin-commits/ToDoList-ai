// Daily automation loop (design doc): cron-parser computes the next
// occurrence of 08:00 (auto plan) and 21:00 (evening review), then we
// setTimeout until then. Re-schedules itself after each fire and on
// settings changes.

import { CronExpressionParser } from "cron-parser";

export const PLAN_CRON = "0 8 * * *";
export const REVIEW_CRON = "0 21 * * *";

export interface ScheduleCallbacks {
  onPlan: () => void;
  onReview: () => void;
  enabled: () => boolean;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let cb: ScheduleCallbacks | null = null;
let currentCron: string | null = null;

function msUntilNext(cronExpr: string, now = new Date()): number {
  const next = CronExpressionParser.parse(cronExpr, { currentDate: now }).next();
  return Math.max(0, next.getTime() - now.getTime());
}

function arm(): void {
  if (timer) clearTimeout(timer);
  if (!cb || !cb.enabled()) {
    currentCron = null;
    return;
  }
  const now = new Date();
  const planIn = msUntilNext(PLAN_CRON, now);
  const reviewIn = msUntilNext(REVIEW_CRON, now);
  const [delay, cron, handler] =
    planIn <= reviewIn
      ? [planIn, PLAN_CRON, cb.onPlan]
      : [reviewIn, REVIEW_CRON, cb.onReview];
  currentCron = cron;
  timer = setTimeout(() => {
    try {
      handler();
    } catch {
      // keep the loop alive
    }
    arm();
  }, delay + 1000);
}

export function startScheduler(callbacks: ScheduleCallbacks): void {
  cb = callbacks;
  arm();
}

export function restartScheduler(): void {
  arm();
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  cb = null;
  currentCron = null;
}

/** Human-readable next run info for the UI. */
export function nextRuns(): Array<{ label: string; at: Date; cron: string }> {
  const now = new Date();
  return [
    { label: "每日自动规划", at: new Date(now.getTime() + msUntilNext(PLAN_CRON, now)), cron: PLAN_CRON },
    { label: "晚间复盘", at: new Date(now.getTime() + msUntilNext(REVIEW_CRON, now)), cron: REVIEW_CRON },
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}
