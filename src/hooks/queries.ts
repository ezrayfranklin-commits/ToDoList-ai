// TanStack Query hooks — the single data entry point (规划 §7:
// 用 TanStack Query + Drizzle 统一数据入口).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDb } from "@/lib/db";
import { removePlanBlock } from "@/lib/planBlocks";
import type {
  DailyPlan,
  Goal,
  Priority,
  Task,
  TimeBlock,
} from "@/lib/types";

// sqlx 返回的列名是 snake_case (scheduled_date 等), 统一映射为 Task 的 camelCase 字段
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

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const qk = {
  tasks: ["tasks"] as const,
  tasksByDate: (d: string) => ["tasks", "date", d] as const,
  inbox: ["tasks", "inbox"] as const,
  openTasks: ["tasks", "open"] as const,
  plan: (d: string) => ["plans", d] as const,
  plans: ["plans"] as const,
  goals: ["goals"] as const,
  runs: ["runs"] as const,
  stats: ["stats"] as const,
  conversations: ["chat", "conversations"] as const,
  messages: (convId: number) => ["chat", "messages", convId] as const,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useTasks() {
  return useQuery({
    queryKey: qk.tasks,
    queryFn: async () => {
      const rows = (await getDb().select<Array<Record<string, unknown>>>(
        "SELECT * FROM tasks ORDER BY status, order_index, id DESC",
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map(toTask);
    },
  });
}

export function useInboxTasks() {
  return useQuery({
    queryKey: qk.inbox,
    queryFn: async () => {
      const rows = (await getDb().select<Array<Record<string, unknown>>>(
        "SELECT * FROM tasks WHERE status = 'inbox' ORDER BY order_index ASC, id ASC",
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map(toTask);
    },
  });
}

export function useTasksByDate(dateStr: string) {
  return useQuery({
    queryKey: qk.tasksByDate(dateStr),
    queryFn: async () => {
      const rows = (await getDb().select<Array<Record<string, unknown>>>(
        `SELECT * FROM tasks
         WHERE scheduled_date = $1 AND status != 'cancelled'
         ORDER BY
           CASE WHEN status = 'done' THEN 1 ELSE 0 END,
           order_index ASC, id ASC`,
        [dateStr],
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map(toTask);
    },
  });
}

export function useOpenTasks() {
  return useQuery({
    queryKey: qk.openTasks,
    queryFn: async () => {
      const rows = (await getDb().select<Array<Record<string, unknown>>>(
        `SELECT * FROM tasks
         WHERE status != 'done' AND status != 'cancelled' AND status != 'inbox'
         ORDER BY scheduled_date IS NULL, scheduled_date ASC, order_index ASC`,
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map(toTask);
    },
  });
}

export function usePlan(dateStr: string) {
  return useQuery({
    queryKey: qk.plan(dateStr),
    queryFn: async () => {
      const rows = (await getDb().select<Array<Record<string, unknown>>>(
        "SELECT * FROM daily_plans WHERE plan_date = $1",
        [dateStr],
      )) as unknown as Array<Record<string, unknown>>;
      if (rows.length === 0) return null;
      const r = rows[0];
      let data: DailyPlan["data"] = null;
      try {
        data = r.data ? JSON.parse(String(r.data)) : null;
      } catch {
        data = null;
      }
      return {
        id: Number(r.id),
        planDate: String(r.plan_date),
        data,
        status: r.status as DailyPlan["status"],
        summary: r.summary ? String(r.summary) : null,
        source: String(r.source ?? "agent"),
        createdAt: String(r.created_at ?? ""),
        updatedAt: String(r.updated_at ?? ""),
      } satisfies DailyPlan;
    },
  });
}

export function usePlans() {
  return useQuery({
    queryKey: qk.plans,
    queryFn: async () => {
      const rows = (await getDb().select<Array<Record<string, unknown>>>(
        "SELECT * FROM daily_plans ORDER BY plan_date DESC LIMIT 30",
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => {
        let data: DailyPlan["data"] = null;
        try {
          data = r.data ? JSON.parse(String(r.data)) : null;
        } catch {
          data = null;
        }
        return {
          id: Number(r.id),
          planDate: String(r.plan_date),
          data,
          status: r.status as DailyPlan["status"],
          summary: r.summary ? String(r.summary) : null,
          source: String(r.source ?? "agent"),
          createdAt: String(r.created_at ?? ""),
          updatedAt: String(r.updated_at ?? ""),
        } satisfies DailyPlan;
      });
    },
  });
}

export function useGoals() {
  return useQuery({
    queryKey: qk.goals,
    queryFn: async () =>
      (await getDb().select<Goal[]>(
        "SELECT * FROM goals WHERE archived = 0 ORDER BY id DESC",
      )) as unknown as Goal[],
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      notes?: string;
      priority?: Priority;
      status?: Task["status"];
      scheduledDate?: string | null;
      timeBlockStart?: string | null;
      timeBlockEnd?: string | null;
      source?: Task["source"];
    }) => {
      const db = getDb();
      const maxRes = (await db.select<Array<{ m: number | null }>>(
        "SELECT MAX(order_index) as m FROM tasks WHERE status = $1",
        [input.status ?? "inbox"],
      )) as unknown as Array<{ m: number | null }>;
      const nextOrder = (maxRes[0]?.m ?? 0) + 1;
      return db.execute(
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
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.tasks });
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: number;
      title?: string;
      notes?: string | null;
      priority?: Priority;
      scheduledDate?: string | null;
      timeBlockStart?: string | null;
      timeBlockEnd?: string | null;
      status?: Task["status"];
    }) => {
      const db = getDb();
      const sets: string[] = [];
      const vals: unknown[] = [];
      const fields: Array<[string, unknown]> = [
        ["title", input.title],
        ["notes", input.notes],
        ["priority", input.priority],
        ["scheduled_date", input.scheduledDate],
        ["time_block_start", input.timeBlockStart],
        ["time_block_end", input.timeBlockEnd],
        ["status", input.status],
      ];
      for (const [col, v] of fields) {
        if (v !== undefined) {
          sets.push(`${col} = $${sets.length + 1}`);
          vals.push(v);
        }
      }
      if (input.status === "done") {
        sets.push(`completed_at = datetime('now')`);
      }
      sets.push(`updated_at = datetime('now')`);
      vals.push(input.id);
      await db.execute(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${vals.length}`,
        vals,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}

export function useToggleTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, done }: { id: number; done: boolean }) => {
      const db = getDb();
      if (done) {
        await db.execute(
          `UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = $1`,
          [id],
        );
      } else {
        await db.execute(
          `UPDATE tasks SET status = 'scheduled', completed_at = NULL, updated_at = datetime('now') WHERE id = $1`,
          [id],
        );
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const db = getDb();
      // 先取任务排期, 删除任务后同步清理对应日期的计划块 (v0.13: 避免残留空计划圆点)
      const rows = (await db.select<Array<{ scheduled_date: string | null }>>(
        "SELECT scheduled_date FROM tasks WHERE id = $1",
        [id],
      )) as unknown as Array<{ scheduled_date: string | null }>;
      await db.execute("DELETE FROM tasks WHERE id = $1", [id]);
      const date = rows[0]?.scheduled_date;
      if (date) await removePlanBlock(date, id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}

export function useReorderTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]) => {
      const db = getDb();
      for (let i = 0; i < ids.length; i++) {
        await db.execute(
          "UPDATE tasks SET order_index = $1, updated_at = datetime('now') WHERE id = $2",
          [i, ids[i]],
        );
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}

// ---------------------------------------------------------------------------
// Plan mutations
// ---------------------------------------------------------------------------

export function useUpdatePlanBlocks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      plan,
      blocks,
    }: {
      plan: DailyPlan;
      blocks: TimeBlock[];
    }) => {
      const db = getDb();
      const data = { ...plan.data, timeBlocks: blocks } as DailyPlan["data"];
      await db.execute(
        `UPDATE daily_plans SET data = $1, updated_at = datetime('now') WHERE id = $2`,
        [JSON.stringify(data), plan.id],
      );
      return data;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.plan(v.plan.planDate) });
      qc.invalidateQueries({ queryKey: qk.tasks });
    },
  });
}

export function useCreateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; description?: string; targetDate?: string }) => {
      return getDb().execute(
        "INSERT INTO goals (title, description, target_date) VALUES ($1, $2, $3)",
        [input.title, input.description ?? null, input.targetDate ?? null],
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.goals }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await getDb().execute("DELETE FROM goals WHERE id = $1", [id]);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.goals }),
  });
}

// ---------------------------------------------------------------------------
// Chat conversations & messages (ChatGPT-style history)
// ---------------------------------------------------------------------------

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "ai";
  content: string;
  createdAt: string;
}

export function useConversations() {
  return useQuery({
    queryKey: qk.conversations,
    queryFn: async () =>
      (await getDb().select<Conversation[]>(
        "SELECT * FROM chat_conversations ORDER BY updated_at DESC, id DESC",
      )) as unknown as Conversation[],
  });
}

export function useMessages(conversationId: number | null) {
  return useQuery({
    queryKey: qk.messages(conversationId ?? -1),
    enabled: conversationId != null,
    queryFn: async () =>
      (await getDb().select<ChatMessage[]>(
        "SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY id ASC",
        [conversationId],
      )) as unknown as ChatMessage[],
  });
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const res = await getDb().execute(
        "INSERT INTO chat_conversations (title) VALUES ('新对话')",
      );
      return Number(res.lastInsertId ?? 0);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations }),
  });
}

export function useRenameConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      await getDb().execute(
        "UPDATE chat_conversations SET title = $1, updated_at = datetime('now') WHERE id = $2",
        [title, id],
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations }),
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      // 手动两步删除：tauri-plugin-sql 连接池未启用 SQLite foreign_keys
      // PRAGMA，FK 级联不可靠，先删消息再删会话
      const db = getDb();
      await db.execute("DELETE FROM chat_messages WHERE conversation_id = $1", [id]);
      await db.execute("DELETE FROM chat_conversations WHERE id = $1", [id]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      qc.invalidateQueries({ queryKey: ["chat"] });
    },
  });
}

export function useAddMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      conversationId: number;
      role: "user" | "ai";
      content: string;
    }) => {
      const db = getDb();
      await db.execute(
        "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [input.conversationId, input.role, input.content],
      );
      await db.execute(
        "UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = $1",
        [input.conversationId],
      );
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.messages(v.conversationId) });
      qc.invalidateQueries({ queryKey: qk.conversations });
    },
  });
}

export function useDayStats(dateStr: string) {
  return useQuery({
    queryKey: [...qk.stats, dateStr],
    queryFn: async () => {
      const db = getDb();
      const done = (await db.select<Array<{ c: number }>>(
        "SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND date(completed_at) = $1",
        [dateStr],
      )) as unknown as Array<{ c: number }>;
      const scheduled = (await db.select<Array<{ c: number }>>(
        "SELECT COUNT(*) as c FROM tasks WHERE status = 'scheduled' AND scheduled_date = $1",
        [dateStr],
      )) as unknown as Array<{ c: number }>;
      const total = Number(done[0]?.c ?? 0) + Number(scheduled[0]?.c ?? 0);
      return {
        done: Number(done[0]?.c ?? 0),
        scheduled: Number(scheduled[0]?.c ?? 0),
        total,
        percent: total === 0 ? 0 : Math.round((Number(done[0]?.c ?? 0) / total) * 100),
      };
    },
  });
}
