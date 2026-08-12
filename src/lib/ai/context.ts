// Context collection for the planning agent (design doc §4.1 收集阶段).
// Reads: calendar events (reminders-cli bridge) + open tasks + inbox + goals.

import type Database from "@tauri-apps/plugin-sql";
import { getDb } from "@/lib/db";
import { weekdayCN } from "@/lib/dates";
import type { CalendarEvent, Goal, PlanContext, Task } from "@/lib/types";

interface TaskRow extends Task {}

interface GoalRow extends Goal {}

export async function fetchCalendarEvents(
  dateStr: string,
): Promise<CalendarEvent[]> {
  try {
    const { listCalendarEvents } = await import("@/lib/reminders");
    return await listCalendarEvents(dateStr);
  } catch {
    return [];
  }
}

export async function buildPlanContext(dateStr: string): Promise<PlanContext> {
  const db: Database = getDb();
  const [openTasks, inboxItems, goalRows, events] = await Promise.all([
    db.select<TaskRow[]>(
      `SELECT * FROM tasks
       WHERE status = 'scheduled' AND completed_at IS NULL
       ORDER BY
         CASE WHEN scheduled_date = $1 THEN 0 ELSE 1 END,
         scheduled_date ASC, order_index ASC`,
      [dateStr],
    ),
    db.select<TaskRow[]>(
      `SELECT * FROM tasks WHERE status = 'inbox' ORDER BY order_index ASC`,
    ),
    db.select<GoalRow[]>(
      `SELECT * FROM goals WHERE archived = 0 ORDER BY target_date IS NULL, target_date ASC`,
    ),
    fetchCalendarEvents(dateStr),
  ]);

  const todayScheduled = openTasks.filter((t) => t.scheduledDate === dateStr);
  const otherOpen = openTasks.filter((t) => t.scheduledDate !== dateStr);
  const carriedOver = todayScheduled.filter(
    (t) => t.source === "carried",
  ).length;

  return {
    date: dateStr,
    weekday: weekdayCN(new Date(dateStr + "T00:00:00")),
    calendarEvents: events,
    openTasks: [
      ...todayScheduled.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        scheduledDate: t.scheduledDate,
        notes: t.notes,
        source: t.source,
        carried: t.source === "carried",
      })),
      ...otherOpen.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        scheduledDate: t.scheduledDate,
        notes: t.notes,
        source: t.source,
        carried: t.source === "carried",
      })),
    ],
    inboxItems: inboxItems.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
    })),
    goals: goalRows.map((g) => ({
      id: g.id,
      title: g.title,
      targetDate: g.targetDate,
    })),
    carriedOver,
  };
}
