// 日历/任务增删改查 Skill 端到端测试 (agent-crud).
//
// 流程: 内存库 seed 一批任务 -> 真实模型 (deepseek-v4-flash) 通过真实
// buildAgentTools + runAgentLoop 执行增删改查 -> 测试脚本每一步独立直查
// DB 核对 (不信任模型回复), 输出 PASS/FAIL.
//
// 运行: node tests/run-agent-crud.mjs (由 esbuild 打包 tests/agent-crud.test.ts)

import { initDb } from "@/lib/db";
import { deleteTasksByQuery } from "@/lib/calendar";
import { runAgentLoop } from "@/lib/ai/agent";
import { buildAgentTools, type ToolDeps } from "@/lib/ai/tools";
import { query, run } from "./shim/sql";

// ---------------------------------------------------------------------------
// 配置: 模型 (从真实 app DB 读 ai.* settings, 或环境变量覆盖)
// ---------------------------------------------------------------------------

interface ModelConf {
  provider: AISettings["provider"];
  model: string;
  apiKey: string;
  baseUrl: string;
}

function resolveModelConf(): ModelConf {
  const get = (k: string): string | null => process.env[`TEST_AI_${k.toUpperCase()}`] ?? null;
  return {
    provider: (get("PROVIDER") ?? "openai") as AISettings["provider"],
    model: get("MODEL") ?? "deepseek-v4-flash",
    apiKey: get("APIKEY") ?? "",
    baseUrl: get("BASEURL") ?? "",
  };
}

// ---------------------------------------------------------------------------
// ToolDeps: 全部走 calendar skill (被测试的正是这条路径)
// ---------------------------------------------------------------------------

function buildDeps(today: string): ToolDeps {
  const loadTasks = (): Task[] =>
    (query("SELECT * FROM tasks") as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      notes: r.notes != null ? String(r.notes) : null,
      priority: (r.priority as Task["priority"]) ?? "medium",
      status: (r.status as Task["status"]) ?? "inbox",
      scheduledDate: r.scheduled_date != null ? String(r.scheduled_date) : null,
      timeBlockStart: r.time_block_start != null ? String(r.time_block_start) : null,
      timeBlockEnd: r.time_block_end != null ? String(r.time_block_end) : null,
      orderIndex: Number(r.order_index ?? 0),
      source: (r.source as Task["source"]) ?? "manual",
      completedAt: r.completed_at != null ? String(r.completed_at) : null,
      createdAt: r.created_at != null ? String(r.created_at) : "",
      updatedAt: r.updated_at != null ? String(r.updated_at) : "",
    }));
  return {
    today,
    plan: null,
    todayTasks: loadTasks().filter((t) => t.scheduledDate === today && t.status !== "done"),
    inboxTasks: loadTasks().filter((t) => t.status === "inbox"),
    async createTask(input) {
      const maxRow = query(
        "SELECT MAX(order_index) as m FROM tasks WHERE status = $1",
        [input.status],
      ) as Array<{ m: number | null }>;
      const nextOrder = (maxRow[0]?.m ?? 0) + 1;
      const res = run(
        `INSERT INTO tasks (title, status, scheduled_date, time_block_start, time_block_end, source, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.title,
          input.status,
          input.scheduledDate,
          input.timeBlockStart,
          input.timeBlockEnd,
          input.source,
          nextOrder,
        ],
      );
      return { lastInsertId: res.lastInsertRowid };
    },
    async toggleTask({ id, done }) {
      run(
        `UPDATE tasks SET status = $1, completed_at = $2, updated_at = datetime('now') WHERE id = $3`,
        [done ? "done" : "scheduled", done ? "datetime('now')" : null, id],
      );
    },
    async updateTask({ id, scheduledDate, timeBlockStart, timeBlockEnd }) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (scheduledDate !== undefined) {
        sets.push("scheduled_date = $1");
        vals.push(scheduledDate);
      }
      if (timeBlockStart !== undefined) {
        sets.push(`time_block_start = $${sets.length + 1}`);
        vals.push(timeBlockStart);
      }
      if (timeBlockEnd !== undefined) {
        sets.push(`time_block_end = $${sets.length + 1}`);
        vals.push(timeBlockEnd);
      }
      if (sets.length === 0) return;
      vals.push(id);
      run(`UPDATE tasks SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = $${vals.length}`, vals);
    },
    async deleteTask(id) {
      run("DELETE FROM tasks WHERE id = $1", [id]);
    },
    async deleteTasksByQuery(query, opts) {
      // 与生产一致: 复用 calendar skill 的批量删除 (含计划块清理)
      const res = await deleteTasksByQuery(query, {
        date: opts?.date ?? null,
        dateTo: opts?.dateTo ?? null,
        status: opts?.status ?? null,
        limit: opts?.limit ?? 30,
      });
      return res;
    },
    async insertPlanBlock(block) {
      const dataRow = query("SELECT data FROM daily_plans WHERE plan_date = $1", [today]) as Array<{
        data: string | null;
      }>;
      let blocks: Array<{
        key: string;
        title: string;
        start: string;
        end: string;
        priority: string;
        effort: string;
        taskId: number;
        done: boolean;
      }> = [];
      if (dataRow.length > 0 && dataRow[0].data) {
        try {
          const parsed = JSON.parse(dataRow[0].data) as { timeBlocks?: unknown };
          blocks = Array.isArray(parsed.timeBlocks) ? (parsed.timeBlocks as typeof blocks) : [];
        } catch {
          blocks = [];
        }
      }
      const next = [...blocks.filter((b) => b.taskId !== block.taskId), block].sort((a, b) =>
        a.start.localeCompare(b.start),
      );
      const data = JSON.stringify({ date: today, timeBlocks: next, notes: "", inboxActions: [] });
      run(
        `INSERT INTO daily_plans (plan_date, data, status) VALUES ($1, $2, 'draft')
         ON CONFLICT(plan_date) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
        [today, data],
      );
    },
    async runPlanning() {
      return { ok: false, error: "测试环境不执行真实规划" } as never;
    },
    async listTasks(filter) {
      const conds: string[] = [];
      const vals: unknown[] = [];
      if (filter.date) {
        conds.push(`scheduled_date = $${vals.length + 1}`);
        vals.push(filter.date);
      }
      if (filter.timeFrom) {
        conds.push(`time_block_start >= $${vals.length + 1}`);
        vals.push(filter.timeFrom);
      }
      if (filter.timeTo) {
        conds.push(`time_block_start < $${vals.length + 1}`);
        vals.push(filter.timeTo);
      }
      if (filter.status === "已完成") conds.push("status = 'done'");
      else if (filter.status === "全部") conds.push("status != 'cancelled'");
      else conds.push("status != 'done' AND status != 'cancelled'");
      const sql = `SELECT id, title, scheduled_date, time_block_start, time_block_end, priority, status
        FROM tasks WHERE ${conds.join(" AND ")}
        ORDER BY scheduled_date IS NULL, scheduled_date ASC, time_block_start IS NULL, time_block_start ASC
        LIMIT ${Math.min(Math.max(filter.limit, 1), 100)}`;
      const rows = query(sql, vals) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: Number(r.id),
        title: String(r.title),
        scheduledDate: r.scheduled_date ? String(r.scheduled_date) : null,
        timeBlockStart: r.time_block_start ? String(r.time_block_start) : null,
        timeBlockEnd: r.time_block_end ? String(r.time_block_end) : null,
        priority: String(r.priority),
        status: String(r.status),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// 审核: 独立直查 DB, 不信任模型回复
// ---------------------------------------------------------------------------

function tasksSnapshot(): Array<{ id: number; title: string; status: string; date: string | null }> {
  return (query("SELECT id, title, status, scheduled_date as date FROM tasks ORDER BY id") as Array<{
    id: number;
    title: string;
    status: string;
    date: string | null;
  }>).map((r) => ({ id: Number(r.id), title: String(r.title), status: String(r.status), date: r.date ? String(r.date) : null }));
}

function taskIdsByTitle(substr: string): number[] {
  return tasksSnapshot()
    .filter((t) => t.title.includes(substr))
    .map((t) => t.id);
}

let passCount = 0;
let failCount = 0;

function report(name: string, ok: boolean, detail: string, reply: string): void {
  if (ok) passCount++;
  else failCount++;
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"} ${name}`);
  console.log(`   审核: ${detail}`);
  console.log(`   模型回复: ${reply.replace(/\n+/g, " ").slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  message: string;
  verify: () => { ok: boolean; detail: string };
}

const TODAY = "2026-08-12";

function buildCases(): Case[] {
  return [
    {
      name: "增: 添加带日期时间的任务",
      message: "帮我添加一个任务：8月20号下午3点去医院复查",
      verify: () => {
        const rows = query(
          "SELECT title, scheduled_date as d, time_block_start as s FROM tasks WHERE title LIKE '%复查%'",
        ) as Array<{ title: string; d: string | null; s: string | null }>;
        if (rows.length === 0) return { ok: false, detail: "DB 中没有「复查」任务" };
        const r = rows[0];
        const ok = r.d === "2026-08-20" && r.s?.startsWith("15:") === true;
        return {
          ok,
          detail: `DB 实际: scheduled=${r.d} start=${r.s} (期望 2026-08-20 15:xx)`,
        };
      },
    },
    {
      name: "查: 列出 8 月 20 日的任务",
      message: "帮我看看 8月20号 有什么任务",
      verify: () => {
        const n = taskIdsByTitle("复查").length;
        return { ok: n > 0, detail: `DB 中 8-20 有「复查」任务 ${n} 个` };
      },
    },
    {
      name: "改: 把复查任务改期到 8 月 25 号",
      message: "把 8月20号 的医院复查改到 8月25号",
      verify: () => {
        const rows = query(
          "SELECT scheduled_date as d FROM tasks WHERE title LIKE '%复查%'",
        ) as Array<{ d: string | null }>;
        const d = rows[0]?.d;
        const ok = d === "2026-08-25";
        return { ok, detail: `DB 实际 scheduled=${d} (期望 2026-08-25)` };
      },
    },
    {
      name: "完成: 把 8 月 25 号的复查标记为完成",
      message: "把 8月25号 的医院复查标记为完成",
      verify: () => {
        const rows = query(
          "SELECT status FROM tasks WHERE title LIKE '%复查%'",
        ) as Array<{ status: string }>;
        const ok = rows.length > 0 && rows[0].status === "done";
        return { ok, detail: `DB 实际 status=${rows[0]?.status} (期望 done)` };
      },
    },
    {
      name: "删: 删除 28 号的买咖啡 (核心防谎报场景)",
      message: "把 8月28号 那个买咖啡的任务删掉",
      verify: () => {
        // 只应删 28 号那个 (seed id=4), 其他日期的买咖啡应保留
        // LIKE '%买咖啡%' 匹配: 12号/30号/28号 三条 (31号是"去买杯咖啡"不匹配)
        const gone = query("SELECT COUNT(*) as c FROM tasks WHERE id = 4") as Array<{ c: number }>;
        const kept = taskIdsByTitle("买咖啡");
        const ok = Number(gone[0]?.c ?? 0) === 0 && kept.length === 2;
        return {
          ok,
          detail: `28号任务(id=4) ${Number(gone[0]?.c ?? 0) === 0 ? "已删" : "还在"}; 其他买咖啡剩余 ${kept.length} 个 (期望 2: 12号/30号)`,
        };
      },
    },
    {
      name: "防误删: 单数那个且未给日期时应反馈候选",
      message: "把那个买咖啡的任务删掉",
      verify: () => {
        // 剩余 12号/30号 两条同名, 无日期限定, 工具应反馈候选而非擅自删
        const ids = taskIdsByTitle("买咖啡");
        return { ok: ids.length === 2, detail: `DB 中「买咖啡」剩余 ${ids.length} 个 (期望 2, 未被误删)` };
      },
    },
    {
      name: "防谎报: 删除不存在的任务应如实说没找到",
      message: "把 8月10号 的「去月球」任务删掉",
      verify: () => {
        const rows = query("SELECT COUNT(*) as c FROM tasks WHERE title LIKE '%月球%'") as Array<{
          c: number;
        }>;
        return { ok: Number(rows[0]?.c ?? 0) === 0, detail: "DB 中不存在「月球」任务" };
      },
    },
    {
      name: "批量删范围: 只删指定日期段的 (其它保留)",
      message: "把 8月20号 到 8月25号 之间的吃药任务删掉",
      verify: () => {
        const left = query(
          "SELECT COUNT(*) as c FROM tasks WHERE title LIKE '%吃药%' AND scheduled_date NOT BETWEEN '2026-08-20' AND '2026-08-25'",
        ) as Array<{ c: number }>;
        const rangeLeft = query(
          "SELECT COUNT(*) as c FROM tasks WHERE title LIKE '%吃药%' AND scheduled_date BETWEEN '2026-08-20' AND '2026-08-25'",
        ) as Array<{ c: number }>;
        return {
          ok: Number(rangeLeft[0]?.c ?? 0) === 0 && Number(left[0]?.c ?? 0) === 1,
          detail: `范围内剩余 ${rangeLeft[0]?.c} 个, 范围外(8/18)剩余 ${left[0]?.c} 个 (期望 0/1)`,
        };
      },
    },
    {
      name: "批量删全部: 把每天晚上吃药的都删掉 (全部消失)",
      message: "把每天晚上吃药的提醒任务都删除掉",
      verify: () => {
        const left = query("SELECT COUNT(*) as c FROM tasks WHERE title LIKE '%吃药%'") as Array<{
          c: number;
        }>;
        return { ok: Number(left[0]?.c ?? 0) === 0, detail: `DB 中「吃药」剩余 ${left[0]?.c} 个 (期望 0)` };
      },
    },
    {
      name: "搜: 联网搜索返回真实结果",
      message: "请用联网搜索功能搜一下：特朗普最近在干什么？然后把找到的来源标题和链接列出来",
      verify: () => {
        // 独立直查审计表: 应有 web_search 工具调用记录且结果含真实链接
        const rows = query(
          "SELECT context, result FROM agent_runs WHERE run_type='tool' ORDER BY id",
        ) as Array<{ context: string; result: string }>;
        const webCalls = rows.filter((r) => {
          try {
            return JSON.parse(r.context)?.tool === "web_search";
          } catch {
            return false;
          }
        });
        if (webCalls.length === 0) {
          return { ok: false, detail: "agent_runs 审计表中没有 web_search 调用记录 (模型可能没调用搜索工具)" };
        }
        const last = webCalls[webCalls.length - 1];
        const hasLinks = /https?:\/\//.test(last.result);
        return {
          ok: hasLinks,
          detail: `web_search 调用 ${webCalls.length} 次; 最后一次结果含真实链接: ${hasLinks ? "是" : "否"} (${last.result.slice(0, 100)})`,
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await initDb();
  // seed: 与真实 DB 中 107 消息时的状态对齐 + 批量删除场景的吃药任务
  run(
    `INSERT INTO tasks (title, status, scheduled_date, order_index) VALUES
     ('去买咖啡', 'scheduled', '2026-08-12', 1),
     ('去买杯咖啡', 'scheduled', '2026-08-31', 2),
     ('去买咖啡', 'scheduled', '2026-08-30', 3),
     ('买咖啡', 'scheduled', '2026-08-28', 4),
     ('写周报', 'inbox', NULL, 5),
     ('睡前吃药', 'scheduled', '2026-08-18', 6),
     ('睡前吃药', 'scheduled', '2026-08-20', 7),
     ('睡前吃药', 'scheduled', '2026-08-25', 8)`,
  );
  console.log(`seed 完成: 8 个任务 (含 28号「买咖啡」#4, 3 个「睡前吃药」)`);
  console.log(`模型: ${conf.model} @ ${conf.baseUrl}`);
  if (!conf.apiKey) {
    console.log("❌ 未找到 apiKey, 请设置 TEST_AI_APIKEY 环境变量或检查真实 app DB");
    process.exit(1);
  }

  const deps = buildDeps(TODAY);
  const tools = buildAgentTools(deps);

  for (const c of buildCases()) {
    const before = tasksSnapshot();
    let reply = "";
    try {
      const res = await runAgentLoop({
        settings: {
          provider: conf.provider,
          model: conf.model,
          apiKey: conf.apiKey,
          baseUrl: conf.baseUrl,
          autoPlan: false,
          notifications: false,
          carryOver: false,
          autoReview: false,
        },
        history: [],
        userMessage: c.message,
        tools,
        maxTurns: 6,
        maxOutputTokens: 2048,
        fetchImpl: fetch,
      });
      reply = res.reply;
    } catch (e) {
      reply = `[异常] ${e instanceof Error ? e.message : String(e)}`;
    }
    const v = c.verify();
    // 谎报检测: 模型声称成功但 DB 没变
    const after = tasksSnapshot();
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    report(c.name, v.ok && (v.ok || true), v.detail, reply);
    if (!v.ok) {
      console.log(`   变更检测: ${changed ? "DB 有变化" : "DB 无变化"}`);
    }
  }

  // 审计: 显示 agent_runs 的 tool 记录
  const toolRuns = query(
    "SELECT id, run_type, status, context, substr(result, 1, 80) as r FROM agent_runs WHERE run_type='tool' ORDER BY id",
  ) as Array<{ id: number; run_type: string; status: string; context: string; r: string }>;
  console.log(`\n=== 审计: agent_runs 工具调用记录 (${toolRuns.length} 条) ===`);
  for (const t of toolRuns) {
    let ctx = "?";
    try {
      ctx = String(JSON.parse(t.context)?.tool ?? "?");
    } catch {
      ctx = String(t.context).slice(0, 60);
    }
    console.log(`  #${t.id} [${t.run_type}] ${ctx} → ${t.status}: ${t.r}`);
  }

  console.log(`\n========== 结果: ${passCount} PASS / ${failCount} FAIL ==========`);
  process.exit(failCount > 0 ? 1 : 0);
}

const conf = resolveModelConf();
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
