// Agent 工具集: 供 runAgentLoop 使用的工具定义与执行（规划 v0.7）。
// 执行逻辑复用现有 mutations 与排期解析（chat.ts 的 findTask/parse*）。
// 参数全部扁平（required + 空字符串表示缺省），兼容 Ollama 工具解析。

import type { AgentTool } from "@/lib/ai/agent";
import { webSearch } from "@/lib/ai/search";
import {
  parseDateHint,
  parseTarget,
  parseTimeHint,
  addMinutesToHHmm,
} from "@/lib/ai/chat";
import { findOneTask, findTaskCandidates, verifyTaskGone } from "@/lib/calendar";
import type { DailyPlan, Priority, Task } from "@/lib/types";
import type { PlanResult } from "@/lib/agent";
import { t } from "@/lib/i18n";

export interface ToolDeps {
  today: string;
  plan: DailyPlan | null;
  todayTasks: Task[];
  inboxTasks: Task[];
  createTask: (input: {
    title: string;
    status: Task["status"];
    scheduledDate: string | null;
    timeBlockStart: string | null;
    timeBlockEnd: string | null;
    source: Task["source"];
  }) => Promise<{ lastInsertId?: number | string }>;
  toggleTask: (input: { id: number; done: boolean }) => Promise<void>;
  updateTask: (input: {
    id: number;
    scheduledDate?: string | null;
    timeBlockStart?: string | null;
    timeBlockEnd?: string | null;
  }) => Promise<void>;
  deleteTask: (id: number) => Promise<void>;
  /** 批量删除（纯数据层实现, 由调用方负责刷新缓存） */
  deleteTasksByQuery: (query: string, opts?: {
    date?: string | null;
    dateTo?: string | null;
    status?: Task["status"] | null;
    limit?: number;
  }) => Promise<{ deleted: Task[]; remaining: Task[] } | null>;
  insertPlanBlock: (block: {
    key: string;
    title: string;
    start: string;
    end: string;
    priority: Priority;
    effort: string;
    taskId: number;
    done: boolean;
  }) => Promise<void>;
  runPlanning: (date: string) => Promise<PlanResult>;
  /** 查询任务（增删改查中的「查」）：按日期/时间范围/状态过滤。 */
  listTasks: (filter: {
    date: string | null;
    timeFrom: string | null;
    timeTo: string | null;
    status: string;
    limit: number;
  }) => Promise<
    Array<{
      id: number;
      title: string;
      scheduledDate: string | null;
      timeBlockStart: string | null;
      timeBlockEnd: string | null;
      priority: string;
      status: string;
    }>
  >;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function buildAgentTools(deps: ToolDeps): AgentTool[] {
  return [
    {
      name: "web_search",
      description:
        "联网搜索（DuckDuckGo/Google/Bing 多引擎自动回退），返回标题/链接/摘要。用于查询最新信息、新闻、价格、资料等。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词（同搜索引擎输入）" },
          maxResults: { type: "integer", description: "返回条数（1-10）" },
        },
        required: ["query", "maxResults"],
      },
      async execute(args) {
        const query = str(args.query);
        if (!query) return "query 不能为空";
        const n = Math.min(Math.max(Number(args.maxResults) || 5, 1), 10);
        const { results, engine, error } = await webSearch(query, n);
        if (error) return `搜索失败：${error}`;
        if (results.length === 0) return `没有搜到「${query}」的相关结果。`;
        return (
          `引擎：${engine}，共 ${results.length} 条：\n` +
          results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n")
        );
      },
    },
    {
      name: "add_task",
      description:
        "添加一个任务。用户提到日期/时刻时填 scheduledDate 与 timeStart：scheduledDate 填换算后的具体日期（YYYY-MM-DD；今天/明天/本周五/下周一等相对说法先换算成具体日期再填）与 timeStart（HH:mm，下午3点→15:00）；没提到就填空字符串（任务进 Inbox）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          scheduledDate: { type: "string", description: "YYYY-MM-DD（今天/明天/本周五等相对日期换算成具体日期），没有则空" },
          timeStart: { type: "string", description: "HH:mm，没有则空" },
        },
        required: ["title", "scheduledDate", "timeStart"],
      },
      async execute(args) {
        const title = str(args.title);
        if (!title) return "title 不能为空";
        const scheduledDate = str(args.scheduledDate)
          ? parseTarget(str(args.scheduledDate))
          : parseDateHint(str(args.scheduledDate) || title);
        const start = parseTimeHint(str(args.timeStart)) ?? parseTimeHint(title);
        const end = start ? addMinutesToHHmm(start, 60) : null;
        const status = scheduledDate ? "scheduled" : "inbox";
        const res = await deps.createTask({
          title,
          status,
          scheduledDate,
          timeBlockStart: start,
          timeBlockEnd: end,
          source: "manual",
        });
        const taskId = Number(res.lastInsertId ?? 0);
        // 今天 + 有时刻 + 今日已有计划 → 插入计划时间块
        if (scheduledDate === deps.today && start && taskId > 0 && deps.plan?.data) {
          await deps.insertPlanBlock({
            key: `task:${taskId}`,
            title,
            start,
            end: end ?? addMinutesToHHmm(start, 60),
            priority: "medium",
            effort: t("effort.1h"),
            taskId,
            done: false,
          });
          return `已添加任务 #${taskId}「${title}」并排入今日计划 ${start}–${end}`;
        }
        if (scheduledDate) {
          return `已添加任务 #${taskId}「${title}」，排期：${scheduledDate}${start ? ` ${start}–${end}` : ""}`;
        }
        return `已添加任务 #${taskId}「${title}」到 Inbox`;
      },
    },
    {
      name: "complete_task",
      description:
        "把某个任务标记为完成。title 用用户提到的任务名；仅当用户明确说了日期（如「把28号的买咖啡完成」）才用 date 填具体日期 YYYY-MM-DD（今天/明天等相对日期先换算成具体日期）；用户没提日期时 date 必须留空，禁止自行猜测或编造日期。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          date: { type: "string", description: "YYYY-MM-DD（可选；仅当用户明确提到日期时才填，否则留空）" },
        },
        required: ["title"],
      },
      async execute(args) {
        const title = str(args.title);
        const date = str(args.date) ? parseTarget(str(args.date)) : null;
        const t = await findOneTask(title, { date });
        if (!t) {
          const cands = await findTaskCandidates(title, { date });
          if (cands.length === 0) return `没有找到「${title}」相关的任务（已搜索全部日期）`;
          return (
            `「${title}」匹配到多个任务，请带 date 参数重试以精确定位：\n` +
            cands.map((c) => `- #${c.id} ${c.title}${c.scheduledDate ? `（${c.scheduledDate}）` : "（未排期）"}`).join("\n")
          );
        }
        await deps.toggleTask({ id: t.id, done: true });
        return `已完成「${t.title}」`;
      },
    },
    {
      name: "reschedule_task",
      description:
        "把某个任务改期/顺延。targetDate 填换算后的具体日期（YYYY-MM-DD；今天/明天/本周五等相对说法先换算成具体日期再填）。title 用用户提到的任务名；仅当用户明确提到原日期时才用 date 填具体日期来精确定位，否则 date 必须留空，禁止自行猜测或编造日期。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          targetDate: { type: "string", description: "YYYY-MM-DD（今天/明天/本周五等换算成具体日期）" },
          date: { type: "string", description: "YYYY-MM-DD（可选；仅当用户明确提到原日期时才填，否则留空）" },
        },
        required: ["title", "targetDate"],
      },
      async execute(args) {
        const title = str(args.title);
        const target = str(args.targetDate) ? parseTarget(str(args.targetDate)) : null;
        const date = str(args.date) ? parseTarget(str(args.date)) : null;
        if (!target) return "targetDate 不能为空";
        const t = await findOneTask(title, { date });
        if (!t) {
          const cands = await findTaskCandidates(title, { date });
          if (cands.length === 0) return `没有找到「${title}」相关的任务（已搜索全部日期）`;
          return (
            `「${title}」匹配到多个任务，请带 date 参数重试以精确定位：\n` +
            cands.map((c) => `- #${c.id} ${c.title}${c.scheduledDate ? `（${c.scheduledDate}）` : "（未排期）"}`).join("\n")
          );
        }
        await deps.updateTask({
          id: t.id,
          scheduledDate: target,
          timeBlockStart: null,
          timeBlockEnd: null,
        });
        return `已把「${t.title}」改期到 ${target}`;
      },
    },
    {
      name: "delete_task",
      description:
        "删除某个任务。title 用用户提到的任务名；仅当用户明确说了日期（如「把28号的买咖啡删掉」）才用 date 填具体日期 YYYY-MM-DD（今天/明天等相对日期先换算成具体日期）；用户没提日期时 date 必须留空，禁止自行猜测或编造日期。删除后会校验确认。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          date: { type: "string", description: "YYYY-MM-DD（可选；仅当用户明确提到日期时才填，否则留空）" },
        },
        required: ["title"],
      },
      async execute(args) {
        const title = str(args.title);
        const date = str(args.date) ? parseTarget(str(args.date)) : null;
        const t = await findOneTask(title, { date });
        if (!t) {
          const cands = await findTaskCandidates(title, { date });
          if (cands.length === 0) return `没有找到「${title}」相关的任务（已搜索全部日期）`;
          return (
            `「${title}」匹配到多个任务，请带 date 参数重试以精确定位：\n` +
            cands.map((c) => `- #${c.id} ${c.title}${c.scheduledDate ? `（${c.scheduledDate}）` : "（未排期）"}`).join("\n")
          );
        }
        const label = `#${t.id}「${t.title}」${t.scheduledDate ? `（${t.scheduledDate}）` : ""}`;
        await deps.deleteTask(t.id);
        // 防谎报: 删除后校验确认任务真的没了
        const gone = await verifyTaskGone(t.id);
        return gone
          ? `已删除 ${label}，并已确认该任务不在列表中`
          : `删除 ${label} 未生效，请重试或检查数据库`;
      },
    },
    {
      name: "delete_tasks_by_query",
      description:
        "批量删除任务：按标题关键词删除所有匹配的任务，仅当用户明确表达批量意图时使用（「把每天晚上吃药的任务都删掉」「把所有买咖啡的删掉」这类含全部/所有/每天/每晚/每个/都等批量词的请求）。" +
        "用户说的是「那个/这个/一个/某个」单个任务时不要用本工具，应改用 delete_task。" +
        "可选 date（起始日期 YYYY-MM-DD）与 dateTo（截止日期 YYYY-MM-DD）限定范围；不限定则删除全库匹配项。" +
        "删除前会先列出命中的任务；若命中太多（超过 30 个）会返回数量要求先缩小范围，不会误删。删除后逐条校验并报告实际删除数量。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "标题关键词（模糊匹配，如：吃药）" },
          date: { type: "string", description: "起始日期 YYYY-MM-DD（可选）" },
          dateTo: { type: "string", description: "截止日期 YYYY-MM-DD（可选）" },
        },
        required: ["query"],
      },
      async execute(args) {
        const query = str(args.query);
        if (!query) return "query 不能为空";
        const date = str(args.date) ? parseTarget(str(args.date)) : null;
        const dateTo = str(args.dateTo) ? parseTarget(str(args.dateTo)) : null;
        const res = await deps.deleteTasksByQuery(query, { date, dateTo });
        if (res === null) {
          return `标题包含「${query}」的任务超过 30 个，为避免误删请先缩小范围（加 date/dateTo 限定日期，或用更精确的关键词）再重试`;
        }
        if (res.deleted.length === 0) {
          return `没有找到标题包含「${query}」的任务（已搜索全部日期）`;
        }
        const first = res.deleted[0];
        const last = res.deleted[res.deleted.length - 1];
        const span =
          first.scheduledDate && last.scheduledDate && first.scheduledDate !== last.scheduledDate
            ? `（${first.scheduledDate} ~ ${last.scheduledDate}）`
            : first.scheduledDate
              ? `（${first.scheduledDate}）`
              : "（未排期）";
        return `已批量删除 ${res.deleted.length} 个标题含「${query}」的任务${span}：\n` +
          res.deleted.map((d) => `- #${d.id} ${d.title}${d.scheduledDate ? `（${d.scheduledDate}）` : ""}`).join("\n") +
          `\n删除后复核：剩余 ${res.remaining.length} 个匹配任务（已全部清理）`;
      },
    },
    {
      name: "plan_today",
      description:
        "生成/重新生成今日计划（一次性生成整个时间块草稿）。当用户说「规划今天」「安排今天的日程」「帮我排一下今天」时使用本工具，不要用 add_task 逐条添加。",
      parameters: {
        type: "object",
        properties: { force: { type: "string", description: "固定填 yes" } },
        required: ["force"],
      },
      async execute() {
        const res = await deps.runPlanning(deps.today);
        if (!res.ok) return `规划失败：${res.error}`;
        const n = res.plan?.data?.timeBlocks.length ?? 0;
        return `今日计划草稿已生成（${n} 个时间块），等待用户在界面确认`;
      },
    },
    {
      name: "list_tasks",
      description:
        "查询/列出任务（增删改查中的「查」）。用户问「有什么任务/规划/安排」「帮我看看/列一下」时使用。" +
        "时间段约定：上午=06:00-12:00，下午=12:00-18:00，晚上=18:00-24:00（用户说下午时 timeFrom=12:00、timeTo=18:00）。" +
        "date 空字符串表示不限日期；status 填 未完成/已完成/全部（空=未完成）。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "今天/明天/本周五/YYYY-MM-DD，空字符串=不限" },
          timeFrom: { type: "string", description: "起始时刻 HH:mm（如 12:00），空字符串=不限" },
          timeTo: { type: "string", description: "结束时刻 HH:mm（如 18:00），空字符串=不限" },
          status: { type: "string", description: "未完成/已完成/全部，空字符串=未完成" },
          limit: { type: "integer", description: "最多返回条数（1-100）" },
        },
        required: ["date", "timeFrom", "timeTo", "status", "limit"],
      },
      async execute(args) {
        const date = str(args.date);
        const timeFrom = str(args.timeFrom);
        const timeTo = str(args.timeTo);
        const status = str(args.status) || "未完成";
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
        const tasks = await deps.listTasks({
          date: date || null,
          timeFrom: timeFrom || null,
          timeTo: timeTo || null,
          status,
          limit,
        });
        if (tasks.length === 0) {
          const where = [date && `日期 ${date}`, timeFrom && `从 ${timeFrom} 起`, timeTo && `到 ${timeTo} 止`]
            .filter(Boolean)
            .join("、");
          return `没有找到${where ? `（${where}）` : ""}${status === "未完成" ? "未完成" : status}任务`;
        }
        const lines = tasks.map((t, i) => {
          const time =
            t.timeBlockStart
              ? `${t.timeBlockStart}–${t.timeBlockEnd ?? ""}`
              : t.scheduledDate
                ? `（${t.scheduledDate}，未排时间）`
                : "（未排期）";
          const prio = t.priority === "high" ? "高" : t.priority === "low" ? "低" : "中";
          const st = t.status === "done" ? "已完成" : "未完成";
          return `${i + 1}. ${time} ${t.title}（${prio}，${st}）`;
        });
        return `共 ${tasks.length} 个任务：\n${lines.join("\n")}`;
      },
    },
  ];
}
