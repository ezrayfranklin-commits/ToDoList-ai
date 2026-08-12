// 日历 CRUD Skill: 工具调用审计 (写 agent_runs 表).
// 每次 agent 工具调用 (增删改查/规划) 落一条记录, 便于事后排查
// "AI 说做了但实际没做" 这类问题 (v0.14: 聊天路径原本不写审计).

import { getDb } from "@/lib/db";

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result: string;
  status: "ok" | "error";
  model: string | null;
  createdAt: string;
}

/** 记录一次 agent 工具调用. run_type = "tool". */
export async function logToolCall(
  tool: string,
  args: unknown,
  result: string,
  status: "ok" | "error",
  model: string | null,
): Promise<void> {
  const db = getDb();
  await db.execute(
    `INSERT INTO agent_runs (run_type, model, status, context, result, feedback, error)
     VALUES ('tool', $1, $2, $3, $4, NULL, $5)`,
    [
      model,
      status === "ok" ? "ok" : "error",
      JSON.stringify({ tool, args }),
      result,
      status === "ok" ? null : result,
    ],
  );
}

/** 读取最近的工具调用记录 (用于排查). */
export async function recentToolCalls(limit = 20): Promise<ToolCallRecord[]> {
  const rows = (await getDb().select<Array<Record<string, unknown>>>(
    `SELECT run_type, model, status, context, result, error, created_at
     FROM agent_runs WHERE run_type = 'tool' ORDER BY id DESC LIMIT $1`,
    [limit],
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let args: unknown = null;
    try {
      const c = r.context ? JSON.parse(String(r.context)) : null;
      args = c?.args ?? null;
    } catch {
      args = null;
    }
    return {
      tool: args ? String((args as { tool?: unknown }).tool ?? "") : "",
      args,
      result: String(r.result ?? ""),
      status: (r.status as "ok" | "error") ?? "error",
      model: r.model ? String(r.model) : null,
      createdAt: String(r.created_at ?? ""),
    };
  });
}
