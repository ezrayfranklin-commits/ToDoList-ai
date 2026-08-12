// Shared domain types.

export type Priority = "low" | "medium" | "high";
export type TaskStatus = "inbox" | "scheduled" | "done" | "cancelled";
export type TaskSource = "manual" | "inbox" | "agent" | "carried";
export type PlanStatus = "draft" | "confirmed" | "reviewed";

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  priority: Priority;
  status: TaskStatus;
  scheduledDate: string | null; // YYYY-MM-DD
  timeBlockStart: string | null; // HH:mm
  timeBlockEnd: string | null; // HH:mm
  orderIndex: number;
  source: TaskSource;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: number;
  title: string;
  description: string | null;
  targetDate: string | null;
  archived: boolean;
  createdAt: string;
}

/** One time block of a daily plan (JSON, stored in daily_plans.data). */
export interface TimeBlock {
  key: string;
  title: string;
  start: string; // HH:mm
  end: string; // HH:mm
  priority: Priority;
  effort: string;
  /** id of the task this block fulfills; null until the plan is applied. */
  taskId: number | null;
  done: boolean;
}

export interface InboxAction {
  taskId: number;
  action: "schedule" | "defer" | "drop";
  note?: string;
}

export interface DailyPlanData {
  date: string; // YYYY-MM-DD
  timeBlocks: TimeBlock[];
  notes: string;
  inboxActions?: InboxAction[];
}

export interface DailyPlan {
  id: number;
  planDate: string;
  data: DailyPlanData | null;
  status: PlanStatus;
  summary: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: number;
  runType: "plan" | "review" | "chat";
  model: string | null;
  status: "ok" | "error";
  context: string | null;
  result: string | null;
  feedback: string | null;
  error: string | null;
  createdAt: string;
}

export interface CalendarEvent {
  title: string;
  start: string; // ISO
  end: string; // ISO
  location?: string;
}

/** Context snapshot handed to the planning agent. */
export interface PlanContext {
  date: string; // YYYY-MM-DD
  weekday: string;
  calendarEvents: CalendarEvent[];
  openTasks: Array<{
    id: number;
    title: string;
    priority: Priority;
    scheduledDate: string | null;
    notes: string | null;
    source: TaskSource;
    carried: boolean;
  }>;
  inboxItems: Array<{ id: number; title: string; priority: Priority }>;
  goals: Array<{ id: number; title: string; targetDate: string | null }>;
  carriedOver: number;
  habits?: string[];
}

export interface AISettings {
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  apiKey: string;
  baseUrl: string;
  autoPlan: boolean;
  notifications: boolean;
  carryOver: boolean;
  autoReview: boolean;
}
