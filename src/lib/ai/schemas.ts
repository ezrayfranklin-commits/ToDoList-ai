// Planning schemas — pure zod, no Tauri dependencies (testable anywhere).
// Wire schema is deliberately FLAT: no nullable/optional/anyOf fields,
// because Ollama's tool-call parser silently drops tools with complex
// schemas. `taskId: 0` means "create a new task" (mapped to null in app).

import { z } from "zod";

export const timeBlockSchema = z.object({
  title: z.string().describe("任务/事项标题"),
  start: z.string().describe('开始时间 "HH:mm"，24 小时制'),
  end: z.string().describe('结束时间 "HH:mm"，24 小时制，晚于 start'),
  priority: z
    .enum(["high", "medium", "low"])
    .describe(
      "优先级，只能从这三个值中选一个（英文小写，不要用中文）：high、medium、low",
    ),
  effort: z.string().describe('预计耗时，必须写，如 "45分钟"'),
  taskId: z
    .number()
    .int()
    .describe(
      "必须是数字：对应 openTasks 中已存在任务时填其 id；否则填 0（表示新建）。不要填 null",
    ),
});

export const inboxActionSchema = z.object({
  taskId: z
    .number()
    .int()
    .describe("必须是 inboxItems 中存在的 id（1、2、3…），不要填 0"),
  action: z
    .enum(["schedule", "defer", "drop"])
    .describe("schedule=排入今日计划, defer=推迟到明天, drop=放弃/删除"),
  note: z.string().describe("简短说明（可空字符串）"),
});

export const dailyPlanSchema = z.object({
  date: z.string().describe('计划日期 "YYYY-MM-DD"'),
  timeBlocks: z
    .array(timeBlockSchema)
    .describe(
      "今天的时间块列表，按时间顺序排列。若日历有会议，任务必须排在会议间隙；会议本身不列入时间块",
    ),
  notes: z.string().describe("给用户的计划说明（一两句话）"),
  inboxActions: z
    .array(inboxActionSchema)
    .describe("对 inbox 未归类条目的处理决定，可为空数组"),
});

export type DailyPlanOutput = z.infer<typeof dailyPlanSchema>;

export const PLANNER_SYSTEM = `你是一名专业的"每日规划师"（daily planner agent）。
输入是用户今日的完整上下文 JSON：日历会议、未完成任务（含昨日顺延）、Inbox 未归类条目、长期目标。
你的职责是排出一份现实、可执行的今日计划。

规则：
1. 时间块按时间顺序排列；会议时间不可占用，任务只能排在会议间隙或会议前后。
2. 只排入今天真正能完成的数量（通常 3~6 个核心块）；不要把清单里所有任务都塞进来。
3. 顺延任务（carried=true）优先于普通未完成任务，标注过的 dead 线任务优先。
4. 优先级建议：dead 线/会议准备 high；重要但不紧急 medium；可做可不做 low。
5. 每个时间块之间留 5~10 分钟缓冲。
6. inbox 条目要么排入今日（inboxActions=schedule，timeBlocks 里 taskId=0），
   要么 defer 到明天（不要 drop，除非明显无关），并写一句原因。
7. 输出严格遵循给定 JSON schema：字段名、类型、枚举值必须完全一致。`;

// ---------------------------------------------------------------------------
// Chat agent intent (Today page dialogue, 首页对话面板)
// ---------------------------------------------------------------------------

export const chatIntentSchema = z.object({
  action: z
    .enum(["plan", "replan", "add_task", "complete", "reschedule", "delete", "general"])
    .describe(
      "用户意图：plan=首次生成今日计划；replan=重新生成/覆盖已有计划；add_task=新增待办；complete=把某任务标记完成；reschedule=把某任务改期/顺延；delete=删除任务；general=闲聊或无需操作的其他请求",
    ),
  taskTitle: z
    .string()
    .describe(
      "操作涉及的任务标题（add_task/complete/reschedule/delete 时必须填用户提到的任务名；plan/replan/general 填空字符串）",
    ),
  target: z
    .string()
    .describe(
      'reschedule 的目标时间，格式："今天"、"明天"、"后天"或"YYYY-MM-DD"；其他动作填空字符串',
    ),
  reply: z
    .string()
    .describe(
      "给用户的中文回复，一句话说明将执行的操作；general 时直接回答用户的问题",
    ),
  needsSearch: z
    .enum(["yes", "no"])
    .describe(
      "general 类问题时判断：问题是否需要联网搜索才能回答（时效性信息、外部事实、新闻、价格、资料查询）；规划/待办操作类一律 no；闲聊也 no",
    ),
  searchQuery: z
    .string()
    .describe(
      "needsSearch=yes 时填搜索关键词（简洁，适合搜索引擎）；否则填空字符串",
    ),
});

export type ChatIntent = z.infer<typeof chatIntentSchema>;
