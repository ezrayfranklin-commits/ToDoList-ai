// Agent 工具集: 供 runAgentLoop 使用的工具定义与执行（规划 v0.7）。
// 执行逻辑复用现有 mutations 与排期解析（chat.ts 的 findTask/parse*）。
// 参数全部扁平（required + 空字符串表示缺省），兼容 Ollama 工具解析。

import type { AgentTool } from "@/lib/ai/agent";
import { webSearch } from "@/lib/ai/search";
import {
  findTask,
  parseDateHint,
  parseTarget,
  parseTimeHint,
  addMinutesToHHmm,
} from "@/lib/ai/chat";
import type { DailyPlan, Priority, Task } from "@/lib/types";
import type { PlanResult } from "@/lib/agent";

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
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function buildAgentTools(deps: ToolDeps): AgentTool[] {
  return [
    {
      name: "web_search",
      description:
        "联网搜索（DuckDuckGo），返回标题/链接/摘要。用于查询最新信息、新闻、价格、资料等。",
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
        "添加一个任务。用户提到日期/时刻时填入 scheduledDate（今天/明天/后天/YYYY-MM-DD）与 timeStart（HH:mm，下午3点→15:00）；没提到就填空字符串（任务进 Inbox）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          scheduledDate: { type: "string", description: "今天/明天/后天/YYYY-MM-DD，没有则空" },
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
            effort: "1小时",
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
      description: "把某个任务标记为完成。title 用用户提到的任务名。",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "任务标题" } },
        required: ["title"],
      },
      async execute(args) {
        const title = str(args.title);
        const t = findTask(title, deps.todayTasks, deps.inboxTasks);
        if (!t) return `没有找到「${title}」相关的任务`;
        await deps.toggleTask({ id: t.id, done: true });
        return `已完成「${t.title}」`;
      },
    },
    {
      name: "reschedule_task",
      description:
        "把某个任务改期/顺延。targetDate 填 今天/明天/后天/YYYY-MM-DD。title 用用户提到的任务名。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          targetDate: { type: "string", description: "今天/明天/后天/YYYY-MM-DD" },
        },
        required: ["title", "targetDate"],
      },
      async execute(args) {
        const title = str(args.title);
        const target = str(args.targetDate) ? parseTarget(str(args.targetDate)) : null;
        const t = findTask(title, deps.todayTasks, deps.inboxTasks);
        if (!t) return `没有找到「${title}」相关的任务`;
        if (!target) return "targetDate 不能为空";
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
      description: "删除某个任务。title 用用户提到的任务名。",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "任务标题" } },
        required: ["title"],
      },
      async execute(args) {
        const title = str(args.title);
        const t = findTask(title, deps.todayTasks, deps.inboxTasks);
        if (!t) return `没有找到「${title}」相关的任务`;
        await deps.deleteTask(t.id);
        return `已删除「${t.title}」`;
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
  ];
}
