// Today page dialogue panel (首页中央 AI 对话面板, 全屏占满).
// ChatGPT 式多会话：消息持久化到 SQLite（chat_conversations /
// chat_messages），会话由左侧边栏切换/新建；本组件只负责渲染与发送。
// 首条用户消息自动作为会话标题；模型上下文携带最近 8 条历史。
// 与左右栏融为一体：无卡片边框、无分隔线，仅靠留白与气泡区分。

import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { Loader2, MessageSquareText, Send, Sparkles, Square, Wand2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  qk,
  useAddMessage,
  useCreateConversation,
  useInboxTasks,
  useMessages,
  usePlan,
  useRenameConversation,
  useTasksByDate,
  useCreateTask,
  useUpdatePlanBlocks,
  useDeleteTask,
  useToggleTask,
  useUpdateTask,
} from "@/hooks/queries";
import { getDb } from "@/lib/db";
import { runPlanning } from "@/lib/agent";
import { upsertTodayPlanBlock } from "@/lib/planBlocks";
import { deleteTasksByQuery } from "@/lib/calendar";
import {
  runChatAgent,
  fallbackIntent,
  findTask,
  parseTarget,
  parseDateHint,
  parseTimeHint,
  addMinutesToHHmm,
  type ChatContext,
} from "@/lib/ai/chat";
import ReactMarkdown from "react-markdown";
import { runAgentLoop } from "@/lib/ai/agent";
import { buildAgentTools } from "@/lib/ai/tools";
import { webSearch } from "@/lib/ai/search";
import { generatePlainText } from "@/lib/ai/ollama";
import { formatDbTime, todayStr, tomorrowStr } from "@/lib/dates";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { useChatRun } from "@/store/chat";
import { cn } from "@/lib/utils";
import { t, lang } from "@/lib/i18n";

/**
 * AI 消息渲染：react-markdown 排版（列表/粗体/表格窄屏友好）。
 * 对话框宽度有限：段落无外边距、列表紧凑缩进、表格小字号并允许换行。
 */
function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="[&_p]:m-0 [&_p+*]:mt-1.5 [&_ul]:m-0 [&_ul]:pl-4 [&_ol]:m-0 [&_ol]:pl-4 [&_li]:my-0.5 [&_strong]:font-semibold [&_em]:italic [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_a]:break-all [&_a]:text-accent [&_table]:my-1 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px] [&_th]:border [&_th]:border-border [&_th]:bg-secondary/60 [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_td]:break-words [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-1]">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return t("chat.greeting.morning");
  if (h >= 12 && h < 18) return t("chat.greeting.noon");
  return t("chat.greeting.evening");
}

function greeting(planStatus: ChatContext["planStatus"], blockCount: number): string {
  switch (planStatus) {
    case "draft":
      return t("chat.greeting.draft", { count: blockCount });
    case "confirmed":
      return t("chat.greeting.confirmed");
    default:
      return t("chat.greeting.default", { greeting: timeGreeting() });
  }
}

/** 基于搜索结果的回答生成（搜索工具后的第二阶段, 引用来源）。 */
const SEARCH_ANSWER_SYSTEM = () =>
  lang() === "en"
    ? `You are the AI assistant of TodoList AI. The user asked a question that needs web search, and below are the search results.
Please answer in English:
1. Base your answer on the search results; do not make things up;
2. Mark the source number after each relevant sentence, e.g. [1];
3. End with a "Sources:" list (number + title + URL), at most 5 items;
4. If the results are insufficient, say so clearly and give what partial info you can.`
    : `你是 TodoList AI 的 AI 助手。用户问了一个需要联网的问题，以下是搜索到的资料。
请用中文回答用户问题：
1. 基于搜索结果作答，不要编造；
2. 在相关句子后标注来源序号，如 [1]；
3. 回答末尾列出「来源：」清单（序号 + 标题 + URL），最多 5 条；
4. 如果搜索结果不足以回答，明确说明并给出部分相关信息。`;

export function TodayChat() {
  const today = todayStr();
  const settings = useSettings();
  const qc = useQueryClient();
  const { currentConversationId, setCurrentConversation } = useUI();

  const { data: plan } = usePlan(today);
  const { data: todayTasks } = useTasksByDate(today);
  const { data: inbox } = useInboxTasks();
  const { data: msgs, isLoading: msgsLoading } = useMessages(currentConversationId);

  const createTask = useCreateTask();
  const toggleTask = useToggleTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateBlocks = useUpdatePlanBlocks();
  const createConversation = useCreateConversation();
  const addMessage = useAddMessage();
  const renameConversation = useRenameConversation();

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // 生成状态提升到全局 store（v0.10）: 切换页面/切软件后生成继续,
  // 回到对话页时「思考中」与停止按钮仍然可见
  const chatRun = useChatRun();
  const busy = chatRun.running;

  const planStatus: ChatContext["planStatus"] = !plan
    ? "none"
    : plan.status === "reviewed"
      ? "reviewed"
      : plan.status;
  const blockCount = plan?.data?.timeBlocks.length ?? 0;

  // 无当前会话时自动新建（ChatGPT 打开即有一个新对话）
  useEffect(() => {
    if (currentConversationId == null && !chatRun.running) {
      createConversation.mutateAsync().then((id) => setCurrentConversation(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversationId]);

  // 消息变化时滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const historyForModel = useMemo(() => {
    const list = msgs ?? [];
    return list
      .slice(-8)
      .map((m) => ({ role: m.role as "user" | "ai", content: m.content }));
  }, [msgs]);

  // agent 循环需要 assistant 角色（chat/completions 协议）
  const agentHistory = useMemo((): Array<{ role: "user" | "assistant"; content: string }> => {
    const list = msgs ?? [];
    return list.slice(-8).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
  }, [msgs]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: qk.plan(today) });
    qc.invalidateQueries({ queryKey: qk.plans });
    qc.invalidateQueries({ queryKey: qk.tasks });
    qc.invalidateQueries({ queryKey: qk.openTasks });
  };

  /** Execute a structured intent, returning the reply to show. */
  const execute = async (
    intent: Awaited<ReturnType<typeof runChatAgent>>,
    raw: string,
  ): Promise<string> => {
    const tasks = todayTasks ?? [];
    const inboxTasks = inbox ?? [];
    switch (intent.action) {
      case "plan":
      case "replan": {
        const res = await runPlanning(today);
        invalidateAll();
        if (!res.ok) {
          return t("chat.planFailed", { error: res.error });
        }
        const n = res.plan?.data?.timeBlocks.length ?? 0;
        return t("chat.planDone", { count: n });
      }
      case "add_task": {
        const title = intent.taskTitle || raw.replace(/^加(?:个)?任务[:：]?\s*/, "").trim();
        if (!title) return t("chat.addNoTitle");
        // 排期语义: 日期 + 时刻（模型填的优先，再从原文兜底解析）
        const scheduledDate = intent.scheduledDate
          ? parseTarget(intent.scheduledDate)
          : parseDateHint(raw);
        const start = parseTimeHint(intent.timeStart) ?? parseTimeHint(raw);
        const end = start ? addMinutesToHHmm(start, 60) : null;
        const status = scheduledDate ? "scheduled" : "inbox";
        const res = await createTask.mutateAsync({
          title,
          status,
          scheduledDate,
          timeBlockStart: start,
          timeBlockEnd: end,
          source: "manual",
        });
        invalidateAll();
        const taskId = Number(res.lastInsertId ?? 0);
        // 今天 + 有时刻 → 写入今日计划时间块（DB 直写，无计划自动建 draft）
        let insertedBlock = false;
        if (scheduledDate === today && start && taskId > 0) {
          await upsertTodayPlanBlock({
            key: `task:${taskId}`,
            title,
            start,
            end: end ?? addMinutesToHHmm(start, 60),
            priority: "medium",
            effort: t("effort.1h"),
            taskId,
            done: false,
          });
          insertedBlock = true;
        }
        const when =
          scheduledDate === today
            ? t("chat.today")
            : scheduledDate === tomorrowStr()
              ? t("chat.tomorrow")
              : scheduledDate ?? "";
        if (insertedBlock) {
          return t("chat.addedToday", { title, start, end });
        }
        if (when) {
          return t("chat.addedWhen", {
            title,
            when,
            time: start ? ` ${start}–${end}` : "",
          });
        }
        return t("chat.addedInbox", { title });
      }
      case "complete": {
        const found = findTask(intent.taskTitle, tasks, inboxTasks);
        if (!found) return t("chat.notFound", { title: intent.taskTitle });
        await toggleTask.mutateAsync({ id: found.id, done: true });
        invalidateAll();
        return t("chat.completed", { title: found.title });
      }
      case "reschedule": {
        const found = findTask(intent.taskTitle, tasks, inboxTasks);
        if (!found) return t("chat.notFound", { title: intent.taskTitle });
        const target = parseTarget(intent.target);
        await updateTask.mutateAsync({
          id: found.id,
          scheduledDate: target,
          timeBlockStart: null,
          timeBlockEnd: null,
        });
        invalidateAll();
        const label = target === today ? t("chat.today") : target === tomorrowStr() ? t("chat.tomorrow") : target;
        return t("chat.rescheduled", { title: found.title, date: label });
      }
      case "delete": {
        const found = findTask(intent.taskTitle, tasks, inboxTasks);
        if (!found) return t("chat.notFound", { title: intent.taskTitle });
        await deleteTask.mutateAsync(found.id);
        invalidateAll();
        return t("chat.deleted", { title: found.title });
      }
      case "general": {
        // 工具调用: 模型判断需要搜索 -> 执行 DuckDuckGo -> 结果交给模型回答
        if (intent.needsSearch === "yes" && intent.searchQuery) {
          const { results, engine, error } = await webSearch(intent.searchQuery, 5);
          if (results.length > 0) {
            const answer = await generatePlainText({
              settings,
              system: SEARCH_ANSWER_SYSTEM(),
              prompt:
                `用户问题：${raw}\n\n搜索结果（${engine}）：\n` +
                results
                  .map(
                    (r, i) =>
                      `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`,
                  )
                  .join("\n"),
              temperature: 0.4,
              maxOutputTokens: 1024,
            });
            return answer.trim();
          }
          return t("chat.searchNoResult", {
            query: intent.searchQuery,
            err: error ? `（${error.split("\n")[1] ?? ""}）` : "",
          });
        }
        return intent.reply || t("chat.received");
      }
    }
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || chatRun.running) return;
    setInput("");
    const ctrl = chatRun.startRun();
    const ctx: ChatContext = {
      date: today,
      planStatus,
      blockCount,
      todayTasks: todayTasks ?? [],
      inboxTasks: inbox ?? [],
    };
    try {
      // 确保会话存在（ChatGPT：没有会话就先新建）
      let convId = currentConversationId;
      if (convId == null) {
        convId = await createConversation.mutateAsync();
        setCurrentConversation(convId);
      }

      await addMessage.mutateAsync({ conversationId: convId, role: "user", content: text });

      // 首条用户消息 → 自动命名会话（ChatGPT 对应逻辑）
      const isFirst = (msgs ?? []).length === 0;
      if (isFirst) {
        const title = text.length > 18 ? `${text.slice(0, 18)}…` : text;
        await renameConversation.mutateAsync({ id: convId, title });
      }

      // agent 循环（GUI 套壳本地 CLI）: 模型自主多轮调用工具
      // （web_search / add_task / complete / reschedule / delete / plan_today），
      // 不限制工具使用；anthropic 协议不同，暂走原单意图路由。
      let reply: string;
      if (settings.provider === "anthropic") {
        const intent = await runChatAgent(text, ctx, settings, [
          ...historyForModel,
          { role: "user", content: text },
        ]);
        reply = await execute(intent, text);
      } else {
        const result = await runAgentLoop({
          settings,
          history: agentHistory,
          userMessage: text,
          tools: buildAgentTools({
            today,
            plan: plan ?? null,
            todayTasks: todayTasks ?? [],
            inboxTasks: inbox ?? [],
            createTask: async (input) => {
              const r = await createTask.mutateAsync({
                title: input.title,
                status: input.status,
                scheduledDate: input.scheduledDate,
                timeBlockStart: input.timeBlockStart,
                timeBlockEnd: input.timeBlockEnd,
                source: input.source,
              });
              invalidateAll();
              return r;
            },
            toggleTask: async (input) => {
              await toggleTask.mutateAsync(input);
              invalidateAll();
            },
            updateTask: async (input) => {
              await updateTask.mutateAsync(input);
              invalidateAll();
            },
            deleteTask: async (id) => {
              await deleteTask.mutateAsync(id);
              invalidateAll();
            },
            deleteTasksByQuery: async (query, opts) => {
              const res = await deleteTasksByQuery(query, {
                date: opts?.date ?? null,
                dateTo: opts?.dateTo ?? null,
                status: opts?.status ?? null,
                limit: opts?.limit ?? 30,
              });
              invalidateAll();
              return res;
            },
            insertPlanBlock: async (block) => {
              // DB 直读直写：agent 一轮内多次插入不互相覆盖，
              // 今日无计划时自动创建 draft（v0.8.1 修复）
              await upsertTodayPlanBlock(block);
              invalidateAll();
            },
            runPlanning: async (date) => {
              const r = await runPlanning(date);
              invalidateAll();
              return r;
            },
            listTasks: async (filter) => {
              const db = getDb();
              const conds: string[] = [];
              const vals: unknown[] = [];
              if (filter.date) {
                conds.push(`scheduled_date = $${vals.length + 1}`);
                vals.push(parseTarget(filter.date));
              }
              if (filter.timeFrom) {
                conds.push(`time_block_start >= $${vals.length + 1}`);
                vals.push(filter.timeFrom);
              }
              if (filter.timeTo) {
                conds.push(`time_block_start < $${vals.length + 1}`);
                vals.push(filter.timeTo);
              }
              if (filter.status === "已完成") {
                conds.push("status = 'done'");
              } else if (filter.status === "全部") {
                conds.push("status != 'cancelled'");
              } else {
                conds.push("status != 'done' AND status != 'cancelled'");
              }
              const sql = `SELECT id, title, scheduled_date, time_block_start, time_block_end, priority, status
                FROM tasks WHERE ${conds.join(" AND ")}
                ORDER BY scheduled_date IS NULL, scheduled_date ASC,
                         time_block_start IS NULL, time_block_start ASC
                LIMIT ${Math.min(Math.max(filter.limit, 1), 100)}`;
              const rows = (await db.select<Array<Record<string, unknown>>>(sql, vals)) as unknown as Array<Record<string, unknown>>;
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
          }),
          maxTurns: 12,
          signal: ctrl.signal,
        });
        reply = result.reply;
      }
      await addMessage.mutateAsync({ conversationId: convId, role: "ai", content: reply });
    } catch (e) {
      if (ctrl.signal.aborted) {
        // 用户点击「停止」: 结束本轮, 记录提示, 不做 fallback
        const convId = currentConversationId;
        if (convId != null) {
          await addMessage.mutateAsync({
            conversationId: convId,
            role: "ai",
            content: t("chat.stopped"),
          });
        }
      } else {
        // 模型不可用/超时 → 关键词 fallback，保证必有回复
        console.warn("[chat] agent loop failed, falling back:", e);
        const convId = currentConversationId;
        if (convId != null) {
          try {
            const intent = fallbackIntent(text, ctx);
            const reply = await execute(intent, text);
            await addMessage.mutateAsync({ conversationId: convId, role: "ai", content: reply });
          } catch (e2) {
            toast.error(e2 instanceof Error ? e2.message : t("chat.sendFailed"));
          }
        }
      }
    } finally {
      if (chatRun.isCurrent(ctrl)) chatRun.finishRun(ctrl);
    }
  };

  /** 停止当前生成（v0.10 停止按钮） */
  const stop = () => {
    chatRun.stopRun();
  };

  const chips = [{ label: t("chat.chip.addTask"), cmd: "加任务：" }];

  const chipClick = (cmd: string) => {
    // 预填输入框，让用户补全任务名（避免发送空指令）
    setInput(cmd);
  };

  const showGreeting = !msgsLoading && (msgs ?? []).length === 0 && !busy;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Panel header — 无边框，仅文字 */}
      <div className="flex items-center justify-between px-4 pb-2 pt-1">
        <span className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <MessageSquareText className="h-3.5 w-3.5" />
          </span>
          AI {t("chat.title")}
        </span>
      </div>

      {/* Message list — fills the panel, scrolls internally */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3"
      >
        {showGreeting && (
          <div className="flex items-end gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Sparkles className="h-3 w-3" />
            </span>
            <div className="max-w-[78%] rounded-xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm">
              <MarkdownContent text={greeting(planStatus, blockCount)} />
              <div className="mt-1 text-[10px] text-muted-foreground">
                {format(new Date(), "HH:mm")}
              </div>
            </div>
          </div>
        )}

        {(msgs ?? []).map((m) =>
          m.role === "ai" ? (
            <div key={m.id} className="flex items-end gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Sparkles className="h-3 w-3" />
              </span>
              <div className="max-w-[78%] rounded-xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm">
                <MarkdownContent text={m.content} />
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {formatDbTime(m.createdAt)}
                </div>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex items-end justify-end gap-2">
              <div className="max-w-[78%] rounded-xl rounded-br-sm bg-accent px-3.5 py-2.5 text-[13px] leading-relaxed text-accent-foreground shadow-sm">
                {m.content}
                <div className="mt-1 text-right text-[10px] text-accent-foreground/70">
                  {formatDbTime(m.createdAt)}
                </div>
              </div>
            </div>
          ),
        )}

        {busy && (
          <div className="flex items-end gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Sparkles className="h-3 w-3" />
            </span>
            <div className="flex items-center gap-1.5 rounded-xl rounded-bl-sm border border-border bg-card px-3 py-2.5 shadow-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-[12px] text-muted-foreground">{t("chat.thinking")}</span>
            </div>
          </div>
        )}
      </div>

      {/* Input area — pinned to the bottom, 无顶部边框 */}
      <div className="px-3 pb-1 pt-2">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.label}
              onClick={() => chipClick(c.cmd)}
              disabled={busy}
              className={cn(
                "flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50",
              )}
            >
              <Wand2 className="h-3 w-3" />
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={t("chat.placeholder")}
            className="h-9 bg-card text-[13px]"
          />
          {busy ? (
            // v0.10: 生成中 → 红色「停止」按钮, 点击中止本轮对话
            <Button
              size="icon"
              className="h-9 w-9 shrink-0 bg-destructive text-white hover:bg-destructive/90"
              onClick={stop}
              aria-label={t("chat.stop")}
              title={t("chat.stop")}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => send()}
              disabled={!input.trim()}
              aria-label={t("chat.send")}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
