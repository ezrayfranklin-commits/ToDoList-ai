// Drizzle schema — single source of truth for the SQLite database.
// Tables: tasks / goals / daily_plans / agent_runs / settings
// (per design doc)

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    notes: text("notes"),
    priority: text("priority", {
      enum: ["low", "medium", "high"],
    })
      .notNull()
      .default("medium"),
    // inbox | scheduled | done | cancelled
    status: text("status", {
      enum: ["inbox", "scheduled", "done", "cancelled"],
    })
      .notNull()
      .default("inbox"),
    // YYYY-MM-DD of the day this task is scheduled for
    scheduledDate: text("scheduled_date"),
    // time block start, "HH:mm"
    timeBlockStart: text("time_block_start"),
    // time block end, "HH:mm"
    timeBlockEnd: text("time_block_end"),
    // ordering within a day / inbox (stable sort key)
    orderIndex: integer("order_index").notNull().default(0),
    // manual | inbox | agent | carried
    source: text("source", {
      enum: ["manual", "inbox", "agent", "carried"],
    })
      .notNull()
      .default("manual"),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("tasks_status_idx").on(t.status),
    index("tasks_scheduled_date_idx").on(t.scheduledDate),
  ],
);

export const goals = sqliteTable("goals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  targetDate: text("target_date"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const dailyPlans = sqliteTable(
  "daily_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // YYYY-MM-DD
    planDate: text("plan_date").notNull(),
    // JSON snapshot of the plan { timeBlocks: [...], notes }
    data: text("data"),
    // draft | confirmed | reviewed
    status: text("status", { enum: ["draft", "confirmed", "reviewed"] })
      .notNull()
      .default("draft"),
    // evening review summary (markdown)
    summary: text("summary"),
    // who generated it: agent | manual
    source: text("source").notNull().default("agent"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("daily_plans_date_idx").on(t.planDate)],
);

export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // plan | review
  runType: text("run_type").notNull(),
  model: text("model"),
  status: text("status", { enum: ["ok", "error"] }).notNull().default("ok"),
  // context JSON sent to the model
  context: text("context"),
  // result JSON returned by the model
  result: text("result"),
  // user feedback after confirmation edits
  feedback: text("feedback"),
  error: text("error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

// ---------------------------------------------------------------------------
// Chat history (ChatGPT-style conversations, 首页对话会话)
// ---------------------------------------------------------------------------

export const chatConversations = sqliteTable("chat_conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // derived from the first user message, e.g. "加任务：买咖啡"
  title: text("title").notNull().default("新对话"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "ai"] }).notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [index("chat_messages_conv_idx").on(t.conversationId)],
);
