// Chat agent for the Today page dialogue (首页对话面板).
// Understands natural-language commands and returns a structured intent:
//   plan / replan / add_task / complete / reschedule / delete / general
// Execution happens in the frontend (TanStack Query mutations); this module
// only decides intent + reply. Falls back to keyword rules when the model
// is unreachable (no key / Ollama down), so basic commands always work.

import { generateObject } from "ai";
import { getModel } from "@/lib/ai/provider";
import { generateStructured } from "@/lib/ai/ollama";
import { chatIntentSchema, type ChatIntent } from "@/lib/ai/schemas";
import { logRun } from "@/lib/ai/plan";
import { todayStr, tomorrowStr, toDateStr } from "@/lib/dates";
import { addDays, parseISO } from "date-fns";
import type { AISettings, Task } from "@/lib/types";

export interface ChatContext {
  date: string;
  planStatus: "none" | "draft" | "confirmed" | "reviewed";
  blockCount: number;
  todayTasks: Task[];
  inboxTasks: Task[];
}

/** 最近对话历史（ChatGPT 式上下文连贯，由调用方从会话消息截取）。 */
export interface ChatHistoryItem {
  role: "user" | "ai";
  content: string;
}

const CHAT_SYSTEM = `你是 TodoList AI 的对话助手，用户通过自然语言指挥待办应用。
判断用户意图并输出结构化结果：
- "规划今天"/"重新规划" → plan 或 replan（已有计划则 replan）
- "加任务：xxx"/"添加xxx"/"记一下xxx" → add_task
  （用户提到日期/时刻时填 scheduledDate（今天/明天/YYYY-MM-DD）与 timeStart（HH:mm，如 下午3点→15:00））
- "完成xxx"/"xxx做完了" → complete
- "把xxx顺延到明天"/"改到后天"/"推迟xxx" → reschedule（target 填 今天/明天/后天/YYYY-MM-DD）
- "删掉xxx"/"删除xxx" → delete
- 其他对话 → general，reply 直接回答；若问题需要联网才能回答
  （时效信息/新闻/价格/外部事实等），needsSearch=yes 并给出简洁的 searchQuery
- taskTitle 必须提取用户提到的具体任务名，找不到就填空字符串。
reply 用中文，简短自然。`;

/** Keyword fallback for when the model cannot be reached. */
function fallbackIntent(message: string, ctx: ChatContext): ChatIntent {
  const m = message.trim();
  const clean = m.replace(/[，。！？、,.!?]/g, " ");

  if (/重新|再来|覆盖/.test(clean) && /规划|安排/.test(clean)) {
    return {
      action: "replan",
      taskTitle: "",
      target: "",
      needsSearch: "no",
      searchQuery: "",
      scheduledDate: "",
      timeStart: "",
      reply: "好的，我重新生成一份今日计划草稿。",
    };
  }
  if (/规划|安排|计划/.test(clean)) {
    const action = ctx.planStatus === "none" ? "plan" : "replan";
    return {
      action,
      taskTitle: "",
      target: "",
      needsSearch: "no",
      searchQuery: "",
      scheduledDate: "",
      timeStart: "",
      reply: "好的，我来为你生成今日计划。",
    };
  }
  const addMatch = clean.match(/(?:加|添加|新增|记一下|记下)[个条]?(?:任务|事项|待办)?[:：]?\s*(.+)/);
  if (addMatch && addMatch[1]) {
    const title = addMatch[1].trim();
    // 从原文提取日期与时刻（模型不可用时的兜底）
    const dateHint = clean.match(/(今天|明天|后天|\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    const timeHint = parseTimeHint(clean);
    return {
      action: "add_task",
      taskTitle: title,
      target: "",
      needsSearch: "no",
      searchQuery: "",
      scheduledDate: dateHint,
      timeStart: timeHint ?? "",
      reply: `好的，把「${title}」记下来${dateHint ? `（${dateHint}${timeHint ? ` ${timeHint}` : ""}）` : ""}。`,
    };
  }
  const doneMatch = clean.match(/(?:完成|做完|搞定|勾掉|办完)[:：]?\s*(.+)/);
  if (doneMatch && doneMatch[1]) {
    return {
      action: "complete",
      taskTitle: doneMatch[1].trim(),
      target: "",
      needsSearch: "no",
      searchQuery: "",
      scheduledDate: "",
      timeStart: "",
      reply: "收到，帮你标记完成。",
    };
  }
  const deferMatch = clean.match(/(?:顺延|推迟|改到|挪到|延到)\s*(.+?)\s*(?:到|至)?\s*(今天|明天|后天|\d{4}-\d{2}-\d{2})/);
  if (deferMatch) {
    return {
      action: "reschedule",
      taskTitle: deferMatch[1].trim(),
      target: deferMatch[2],
      needsSearch: "no",
      searchQuery: "",
      scheduledDate: "",
      timeStart: "",
      reply: "好的，帮你改期。",
    };
  }
  const delMatch = clean.match(/(?:删除|删掉|移除|去掉)[:：]?\s*(.+)/);
  if (delMatch && delMatch[1]) {
    return {
      action: "delete",
      taskTitle: delMatch[1].trim(),
      target: "",
      needsSearch: "no",
      searchQuery: "",
      scheduledDate: "",
      timeStart: "",
      reply: "好的，帮你删除。",
    };
  }
  return {
    action: "general",
    taskTitle: "",
    target: "",
    // 模型不可用时, 若消息像信息查询类问题, 仍可触发搜索
    ...(isSearchLike(clean)
      ? { needsSearch: "yes" as const, searchQuery: clean.slice(0, 80) }
      : { needsSearch: "no" as const, searchQuery: "" }),
    scheduledDate: "",
    timeStart: "",
    reply:
      "我可以帮你：规划今天、加任务（如「加任务：买咖啡」）、标记完成、顺延到明天、删除任务，或搜索资料。试试对我说「规划今天」？",
  };
}

/** 粗判消息是否像信息查询（模型不可用时的兜底触发搜索）。 */
function isSearchLike(text: string): boolean {
  return /(查|搜|找|是什么|怎么样|多少钱|价格|新闻|最新|推荐|对比|教程|用法|怎么用|天气|行情)/.test(
    text,
  );
}

export async function runChatAgent(
  message: string,
  ctx: ChatContext,
  settings: AISettings,
  history: ChatHistoryItem[] = [],
): Promise<ChatIntent> {
  const statusBrief = {
    date: ctx.date,
    planStatus: ctx.planStatus,
    blockCount: ctx.blockCount,
    todayTasks: ctx.todayTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      timeBlockStart: t.timeBlockStart,
    })),
    inboxCount: ctx.inboxTasks.length,
  };
  const historyBlock =
    history.length > 0
      ? `\n\n最近对话：\n${history
          .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content}`)
          .join("\n")}`
      : "";
  const prompt = `用户消息：${message}${historyBlock}\n\n当前状态：${JSON.stringify(statusBrief)}\n\n请判断意图并回复。`;
  try {
    let intent: ChatIntent;
    // 30s 整体超时：模型挂起/网关卡住时保证必有回复（fallback），不白屏不静默
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("意图识别超时(30s)")), 30_000),
    );
    if (settings.provider === "ollama" || settings.provider === "openai") {
      // Third-party OpenAI-compatible gateways (opencode.ai etc.) need the
      // plain /chat/completions generator (see lib/ai/ollama.ts header).
      intent = await Promise.race([
        generateStructured({
          settings,
          system: CHAT_SYSTEM,
          prompt,
          schema: chatIntentSchema,
          temperature: 0.3,
        }),
        timeout,
      ]);
    } else {
      const { object } = await generateObject({
        model: getModel(settings),
        schema: chatIntentSchema,
        system: CHAT_SYSTEM,
        prompt,
        temperature: 0.3,
      });
      intent = object;
    }
    await logRun("chat", settings.model, "ok", { message }, intent, null, null);
    return intent;
  } catch (e) {
    await logRun(
      "chat",
      settings.model,
      "error",
      { message },
      null,
      null,
      e instanceof Error ? e.message : String(e),
    );
    return fallbackIntent(message, ctx);
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by the chat UI
// ---------------------------------------------------------------------------

/** Loose title matching against today's tasks, then inbox. */
export function findTask(
  title: string,
  todayTasks: Task[],
  inboxTasks: Task[],
): Task | null {
  const t = title.trim();
  if (!t) return null;
  const pool = [...todayTasks.filter((x) => x.status !== "done"), ...inboxTasks];
  const exact = pool.find((x) => x.title === t);
  if (exact) return exact;
  const contains = pool.find((x) => x.title.includes(t) || t.includes(x.title));
  return contains ?? null;
}

/** Parse chat target ("今天"/"明天"/"后天"/YYYY-MM-DD) into a date string. */
export function parseTarget(target: string): string {
  switch (target.trim()) {
    case "今天":
      return todayStr();
    case "明天":
      return tomorrowStr();
    case "后天":
      return toDateStr(addDays(parseISO(todayStr() + "T00:00:00"), 2));
    default: {
      const m = target.trim().match(/^\d{4}-\d{2}-\d{2}$/);
      return m ? m[0] : tomorrowStr();
    }
  }
}

/** 把 "15:00" / "下午3点" / "3点" 等自然语言时刻归一化为 "HH:mm"，解析不了返回 null。 */
export function parseTimeHint(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  const iso = t.match(/^(\d{1,2}):(\d{2})$/);
  if (iso) {
    const h = Number(iso[1]);
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, "0")}:${iso[2]}`;
    return null;
  }
  const cn = t.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?(\d{1,2})\s*[点时](\d{1,2})?\s*分?/);
  if (!cn) return null;
  let h = Number(cn[2]);
  const m = cn[3] ? Number(cn[3]) : 0;
  if (h < 0 || h > 24 || m > 59) return null;
  const period = cn[1] ?? "";
  if (period === "下午" || period === "傍晚" || period === "晚上") {
    if (h < 12) h += 12;
  } else if (!period && h <= 6) {
    // 口语里的 "3点" 默认下午；"9点" 默认上午
    h += 12;
  }
  if (h >= 24) h -= 12;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 从原文提取日期提示（今天/明天/后天/YYYY-MM-DD），解析为日期串，没有返回 null。 */
export function parseDateHint(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(今天|明天|后天|\d{4}-\d{2}-\d{2})/);
  return m ? parseTarget(m[1]) : null;
}

/** "HH:mm" 加 N 分钟，跨天回绕，返回 "HH:mm"。 */
export function addMinutesToHHmm(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}
