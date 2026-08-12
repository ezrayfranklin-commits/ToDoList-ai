// macOS 提醒事项桥接（M3 系统联动，design doc）。
// 优先使用社区现成 CLI `remindctl`（Apple Reminders 官方数据，无需 MCP Server，
// 规避 mcp-server-reminders 的 alpha 质量风险 —— 规划 §7 的降级路径）。
// 通过 tauri-plugin-shell 拉起子进程；权限未授权时优雅降级。

import { Command } from "@tauri-apps/plugin-shell";
import type { CalendarEvent } from "@/lib/types";

const BIN = "remindctl";

export interface BridgeStatus {
  installed: boolean;
  authorized: boolean;
  detail: string;
}

async function runJson(args: string[]): Promise<unknown> {
  const cmd = Command.create(BIN, args);
  const out = await cmd.execute();
  if (out.code !== 0) {
    throw new Error(`remindctl ${args[0]} failed (${out.code}): ${out.stderr || out.stdout}`);
  }
  const stdout = out.stdout.toString().trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    // status 等命令输出纯文本 (非 JSON): 原样返回字符串
    return stdout;
  }
}

/** Check binary presence + Reminders authorization. */
export async function checkRemindersBridge(): Promise<BridgeStatus> {
  try {
    const status = await runJson(["status"]);
    if (typeof status === "string") {
      // remindctl status 输出纯文本: "Reminders access: granted/denied/Not determined"
      if (/granted/i.test(status)) {
        return { installed: true, authorized: true, detail: "已授权，可读取提醒事项/日历" };
      }
      if (/denied/i.test(status)) {
        return {
          installed: true,
          authorized: false,
          detail: "未授权。请在 设置 → 隐私与安全性 → 提醒事项 中允许本应用（或运行 remindctl authorize）",
        };
      }
      return {
        installed: true,
        authorized: false,
        detail: `未授权（${status.trim()}）。运行 remindctl authorize 触发系统授权弹窗`,
      };
    }
    const s = status as { authorized?: boolean; message?: string };
    if (s?.authorized) {
      return { installed: true, authorized: true, detail: "已授权，可读取提醒事项/日历" };
    }
    return {
      installed: true,
      authorized: false,
      detail:
        "未授权。请在 设置 → 隐私与安全性 → 提醒事项 中允许本应用（或运行 remindctl authorize）",
    };
  } catch (e) {
    return {
      installed: false,
      authorized: false,
      detail:
        e instanceof Error && e.message.includes("executable")
          ? "未检测到 remindctl，请先安装（brew install remindctl）"
          : e instanceof Error
            ? e.message
            : String(e),
    };
  }
}

/** 触发系统授权弹窗 (remindctl authorize). 返回新状态. */
export async function requestBridgeAuthorization(): Promise<BridgeStatus> {
  try {
    const cmd = Command.create(BIN, ["authorize"]);
    const out = await cmd.execute();
    void out;
  } catch {
    // 授权可能弹窗或失败, 以 status 为准
  }
  return checkRemindersBridge();
}

/**
 * Reminders due on a given date (YYYY-MM-DD) as pseudo-calendar events.
 * Gracefully returns [] when unavailable.
 * 隐私: 通过 remindctl 读取 Apple 提醒事项/日历 (仅读取, 需要系统授权).
 */
export async function listCalendarEvents(dateStr: string): Promise<CalendarEvent[]> {
  try {
    const data = await runJson(["show", dateStr, "-j"]);
    const items = Array.isArray(data) ? data : [];
    return items
      .map((r) => {
        const row = r as {
          title?: string;
          dueDate?: string;
          dueDateComponents?: { year?: number; month?: number; day?: number; hour?: number; minute?: number };
          notes?: string;
          url?: string;
        };
        const dc = row.dueDateComponents;
        const start = dc
          ? new Date(
              dc.year ?? 1970,
              (dc.month ?? 1) - 1,
              dc.day ?? 1,
              dc.hour ?? 9,
              dc.minute ?? 0,
            ).toISOString()
          : `${dateStr}T09:00:00`;
        const end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
        return {
          title: row.title ?? "提醒事项",
          start,
          end,
          location: row.url ?? undefined,
        } satisfies CalendarEvent;
      })
      .filter((e) => e.start.startsWith(dateStr));
  } catch {
    return [];
  }
}

/** Create a reminder in the default list (optional sync, 规划 M3). */
export async function addReminder(title: string, dueDate: string, list?: string): Promise<boolean> {
  try {
    const args = ["add", title, "--due", dueDate];
    if (list) args.push("--list", list);
    const cmd = Command.create(BIN, args);
    const out = await cmd.execute();
    return out.code === 0;
  } catch {
    return false;
  }
}

/** Push a task to macOS Reminders (used by the optional sync toggle). */
export async function syncTaskToReminders(
  task: { title: string; scheduledDate: string | null },
): Promise<boolean> {
  if (!task.scheduledDate) return false;
  return addReminder(task.title, task.scheduledDate);
}
