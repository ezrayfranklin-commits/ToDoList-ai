// 内置智能体主循环 (自研, 纯 TS, 零安装、跑在应用内).
//
// 一个健壮的多轮工具调用循环, 面向本地 Ollama 与 OpenAI 兼容网关:
//   - 多轮工具调用, 直到模型给出最终回答或超过 maxTurns
//   - 错误分类重试: 鉴权/区域错误不重试并提示, 5xx/429/网络抖动退避重试一次
//   - 工具参数修复: 模型输出的坏 JSON 自动去 code fence / 截取 {} / 去尾逗号
//   - 输出清洗: 去除 null 与控制字符, 防渲染与存储问题
//   - 用户中断: signal.abort 立即结束本轮, 标记中断消息
//
// 提示词 (DEFAULT_SYSTEM)、工具集 (tools) 与数据层为独立模块, 与本循环一一对应.

import { endpoint, friendlyHttpError, type ChatMessage } from "@/lib/ai/ollama";
import { format } from "date-fns";
import { weekdayCN } from "@/lib/dates";
import { logToolCall } from "@/lib/calendar";
import type { AISettings } from "@/lib/types";

/** 一个可调用工具：元数据（扁平 JSON Schema，Ollama 兼容）+ 执行函数。 */
export interface AgentTool {
  name: string;
  description: string;
  /** 扁平 JSON Schema：所有字段 required，无 anyOf/nullable（Ollama 解析限制） */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** 会话历史（映射自 chat_messages 的 user/ai）。 */
export interface AgentTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentLoopParams {
  settings: AISettings;
  system?: string;
  history: AgentTurn[];
  userMessage: string;
  tools: AgentTool[];
  maxTurns?: number;
  maxOutputTokens?: number;
  /** 停止按钮: 传入后 abort 立即中止本轮生成 */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface AgentLoopResult {
  reply: string;
  turns: number;
  toolCalls: number;
}

const DEFAULT_SYSTEM = `你是 TodoList AI 内置的本地智能体，运行在用户的 MacBook 上（相当于一个本地 CLI 的对话界面）。
你可以自主使用以下工具来帮助用户：规划今日计划、添加任务、标记完成、改期/顺延、删除任务、联网搜索（DuckDuckGo）。
规则：
- 根据用户意图自主决定调用哪些工具、调用几次、是否先搜索；不受任何固定流程限制。
- 用户要求「规划今天/安排全天日程/生成一天的计划」时，调用 plan_today 一次性生成整个计划，
  不要用 add_task 逐条添加任务。
- 批量操作优先用批量工具：用户说「把每天晚上/每天/所有/全部 X 任务删掉」时，调用
  delete_tasks_by_query 一次完成（可按日期范围限定），绝不要用 delete_task 逐条循环删除；
  同理批量添加（如「加未来30天每晚睡前的吃药提醒」）逐条 add_task 太慢时应说明并询问用户。
- 删除类指令的句尾助词（掉/了/吧）不是任务名的一部分，任务名取核心名词（如
  「把每天晚上吃药的任务都删除掉」→ 任务是「吃药」）。
- 用户询问「有什么任务/规划/安排」「帮我看看/列一下」时，调用 list_tasks 查询后再回答；
  你具备查询能力，不要说"没有查看任务的功能"。
- 列任务或任何清单时，用简单的编号列表（1. 2. 3.…）每条一行，或按时间顺序分行列出；
  禁止使用 Markdown 表格（对话框宽度有限，表格挤在一起无法阅读）。
- 需要最新信息（新闻/价格/外部事实）时先搜索再回答，并标注来源。
- 每个工具返回结果后，若还需更多信息可继续调用其他工具。
- 最终用中文给用户简洁清晰的总结；用户闲聊时直接友好回答，无需调用工具。
- 消息里提到的任务名，如与工具参数需要精确匹配，尽量用用户原话。
- 工具返回的结果是事实，必须如实转述：工具返回「没有找到」时必须告诉用户找不到，
  禁止虚构成功（例如工具没删掉却说已删除）。只有在你看到工具明确返回成功结果后才能确认操作完成。`;

/**
 * 当前日期上下文块: 拼接进系统提示, 让模型能换算"本周五/下周一"等相对日期.
 * 模型没有实时时钟, 不给它日期它只能猜或反问用户.
 */
export function dateContextBlock(now: Date = new Date()): string {
  const today = format(now, "yyyy-MM-dd");
  const weekday = weekdayCN(now);
  const hm = format(now, "HH:mm");
  return (
    `\n[当前时间] 今天是 ${today}（${weekday}），当前时刻 ${hm}。` +
    `\n换算规则：用户说「今天」即 ${today}，「明天」是 ${today} 的次日；` +
    `「本周五/下周一/上周三」等相对日期请先换算成具体的 YYYY-MM-DD 再填入工具参数，` +
    `不要在回答中反问用户今天是几号。`
  );
}

let tauriFetchFn: typeof fetch | null = null;

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!tauriFetchFn) {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetchFn = mod.fetch as unknown as typeof fetch;
  }
  return tauriFetchFn(input, init);
}

// ---------------------------------------------------------------------------
// 机制 1: 错误分类重试 (鉴权/区域不重试, 5xx/429/网络抖动可重试)
// ---------------------------------------------------------------------------

type FailoverReason =
  | "retryable" // 网络抖动 / 5xx / 429: 退避重试
  | "auth" // 401/403: 不重试, 提示检查 Key
  | "region" // RegionError: 不重试, 提示开通
  | "fatal"; // 其他: 不重试

function classifyApiError(status: number, body: string): FailoverReason {
  if (status === 401 || status === 403) {
    return body.includes("RegionError") ? "region" : "auth";
  }
  if (status === 429 || status >= 500 || status === 0) return "retryable";
  return "fatal";
}

/** jittered backoff: base*2^n ± 30%, 指数退避带随机抖动防止同时重试。 */
function jitteredBackoffMs(attempt: number): number {
  const base = 800 * 2 ** attempt;
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

// ---------------------------------------------------------------------------
// 机制 2: 工具调用参数修复 (坏 JSON 自动修复)
// ---------------------------------------------------------------------------

/** 尝试修复模型输出的坏 JSON 参数: 去 code fence / 截取 {} 区间 / 去尾逗号。 */
export function repairToolCallArguments(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  // 去尾逗号（对象/数组最后一个元素后的 ,）
  s = s.replace(/,\s*([}\]])/g, "$1");
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    const repaired = repairToolCallArguments(raw ?? "");
    if (repaired !== null) {
      try {
        const v = JSON.parse(repaired);
        return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 机制 3: 输出清洗 (去除控制字符, 防渲染/存储问题)
// ---------------------------------------------------------------------------

/** 清洗模型输出: 去除 null 字符/控制字符, 防渲染与存储问题。 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// 单次模型调用 (带重试: 一次性守卫 + jittered backoff)
// ---------------------------------------------------------------------------

interface ChatOnceResult {
  message: ChatMessage;
}

async function chatOnce(
  settings: AISettings,
  messages: ChatMessage[],
  tools: unknown[],
  temperature: number,
  maxTokens: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ChatOnceResult> {
  // 重试守卫: 每个错误分类只重试一次
  let retryableAttempted = false;
  let lastError: unknown = null;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    let res: Response;
    try {
      // 隐私: 会话/任务上下文将发送到用户配置的模型端点 (云端模型外发, 本地 Ollama 不外发)
      res = await fetchImpl(endpoint(settings), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          tools,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal,
      });
    } catch (e) {
      // 网络层错误: 用户停止直接抛, 否则按可重试处理
      if (signal?.aborted) throw e;
      lastError = e;
      if (!retryableAttempted) {
        retryableAttempted = true;
        await new Promise((r) => setTimeout(r, jitteredBackoffMs(attempt)));
        continue;
      }
      throw new Error(`网络请求失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("模型返回为空");
      return { message };
    }
    const body = await res.text();
    const reason = classifyApiError(res.status, body);
    if (reason === "retryable" && !retryableAttempted) {
      retryableAttempted = true;
      await new Promise((r) => setTimeout(r, jitteredBackoffMs(attempt)));
      continue;
    }
    // auth / region / fatal: 不重试, 抛出带可操作提示的错误
    throw friendlyHttpError(res.status, body, settings.model);
  }
}

// ---------------------------------------------------------------------------
// 主循环: 多轮工具调用 -> 最终回答
// ---------------------------------------------------------------------------

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const {
    settings,
    system = DEFAULT_SYSTEM,
    history,
    userMessage,
    tools,
    maxTurns = 6,
    maxOutputTokens = 4096,
    signal,
    fetchImpl = defaultFetch,
  } = params;

  const messages: ChatMessage[] = [
    { role: "system", content: `${system}\n${dateContextBlock()}` },
    ...history.map((h): ChatMessage => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];
  const toolSpecs = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let turns = 0;
  let toolCalls = 0;

  for (let i = 0; i < maxTurns; i++) {
    turns++;
    const { message } = await chatOnce(settings, messages, toolSpecs, 0.4, maxOutputTokens, fetchImpl, signal);
    const calls = (message.tool_calls ?? []).filter(
      (c) => c.type === "function" && c.function && c.function.name,
    );

    // 模型不再调用工具 → 这是最终回答
    if (calls.length === 0) {
      const reply = sanitizeText(message.content ?? "");
      if (!reply) throw new Error("模型返回为空");
      return { reply, turns, toolCalls };
    }

    // 执行本轮所有工具调用, 结果作为 tool 消息回填
    // reasoning_content 占位: 思考模式网关 (如 deepseek-v4-flash) 要求 assistant
    // 的 tool_calls 消息带 reasoning_content, 否则 400; 普通模型忽略该字段
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      reasoning_content: "",
      tool_calls: message.tool_calls,
    });
    for (const call of calls) {
      toolCalls++;
      const tool = tools.find((t) => t.name === call.function.name);
      let out: string;
      let ok = true;
      if (!tool) {
        out = `未知工具：${call.function.name}`;
        ok = false;
      } else {
        const args = parseArgs(call.function.arguments);
        if (args === null) {
          // 参数损坏且无法修复: 反馈模型重新调用
          out = `工具 ${call.function.name} 的参数不是合法 JSON（原始: ${String(
            call.function.arguments,
          ).slice(0, 120)}），请重新调用该工具并给出合法 JSON 参数。`;
          ok = false;
        } else {
          try {
            out = await tool.execute(args);
          } catch (e) {
            out = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
            ok = false;
          }
        }
      }
      // 审计: 每次工具调用落库 (agent_runs, run_type='tool'), 便于排查"说做了没做"
      await logToolCall(tool?.name ?? "unknown", call.function.arguments, out, ok ? "ok" : "error", settings.model).catch(() => {});
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }

  throw new Error(`一次对话中工具调用超过 ${maxTurns} 轮，已停止`);
}
