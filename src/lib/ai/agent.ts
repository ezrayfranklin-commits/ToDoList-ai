// pi-style agent loop (GUI 套壳的本地 CLI 智能体, 规划 v0.7).
//
// 与 pi 的 CLI 行为对齐：模型自主决定调用哪些工具、调用几次、是否搜索，
// 多轮循环直到给出最终回答。协议为 /chat/completions + tools（Ollama 与
// 第三方 OpenAI 兼容网关通用）。工具执行由调用方注入（前端 mutations），
// 本模块只负责「思考 → 工具调用 → 观察结果 → 继续」的循环。
//
// 不限制工具使用：提示词不规定调用顺序/次数，工具集全量暴露。

import { endpoint, friendlyHttpError, type ChatMessage } from "@/lib/ai/ollama";
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
- 用户询问「有什么任务/规划/安排」「帮我看看/列一下」时，调用 list_tasks 查询后再回答；
  你具备查询能力，不要说"没有查看任务的功能"。
- 列任务或任何清单时，用简单的编号列表（1. 2. 3.…）每条一行，或按时间顺序分行列出；
  禁止使用 Markdown 表格（对话框宽度有限，表格挤在一起无法阅读）。
- 需要最新信息（新闻/价格/外部事实）时先搜索再回答，并标注来源。
- 每个工具返回结果后，若还需更多信息可继续调用其他工具。
- 最终用中文给用户简洁清晰的总结；用户闲聊时直接友好回答，无需调用工具。
- 消息里提到的任务名，如与工具参数需要精确匹配，尽量用用户原话。`;

let tauriFetchFn: typeof fetch | null = null;

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!tauriFetchFn) {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetchFn = mod.fetch as unknown as typeof fetch;
  }
  return tauriFetchFn(input, init);
}

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
  const res = await fetchImpl(endpoint(settings), {
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
  if (!res.ok) {
    const body = await res.text();
    throw friendlyHttpError(res.status, body, settings.model);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("模型返回为空");
  return { message };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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
    { role: "system", content: system },
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
      const reply = (message.content ?? "").trim();
      if (!reply) throw new Error("模型返回为空");
      return { reply, turns, toolCalls };
    }

    // 执行本轮所有工具调用，结果作为 tool 消息回填
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of calls) {
      toolCalls++;
      const tool = tools.find((t) => t.name === call.function.name);
      let out: string;
      if (!tool) {
        out = `未知工具：${call.function.name}`;
      } else {
        try {
          out = await tool.execute(parseArgs(call.function.arguments));
        } catch (e) {
          out = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }

  throw new Error(`一次对话中工具调用超过 ${maxTurns} 轮，已停止`);
}
