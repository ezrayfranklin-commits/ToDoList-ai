// Today page dialogue panel (首页中央 AI 对话面板, 全屏占满).
// ChatGPT 式多会话：消息持久化到 SQLite（chat_conversations /
// chat_messages），会话由左侧边栏切换/新建；本组件只负责渲染与发送。
// 首条用户消息自动作为会话标题；模型上下文携带最近 8 条历史。
// 与左右栏融为一体：无卡片边框、无分隔线，仅靠留白与气泡区分。

import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { Loader2, MessageSquareText, Send, Sparkles, Wand2 } from "lucide-react";
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
import { runPlanning } from "@/lib/agent";
import {
  runChatAgent,
  findTask,
  parseTarget,
  parseDateHint,
  parseTimeHint,
  addMinutesToHHmm,
  type ChatContext,
} from "@/lib/ai/chat";
import { webSearch } from "@/lib/ai/search";
import { generatePlainText } from "@/lib/ai/ollama";
import { formatDbTime, todayStr, tomorrowStr } from "@/lib/dates";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";

function greeting(planStatus: ChatContext["planStatus"], blockCount: number): string {
  switch (planStatus) {
    case "draft":
      return `AI 已生成今日计划草稿（${blockCount} 个时间块）。可以直接说「确认」，或让我「重新规划」；也可以拖拽右侧时间块调整。`;
    case "confirmed":
      return "今日计划已确认，开工吧！可以随时对我说：「加任务：…」「把 … 顺延到明天」「完成 …」。";
    default:
      return "早上好！我是你的 AI 规划师。说「规划今天」，我读取你的待办与提醒事项来排今天的计划；也可以问我问题（我会联网搜索），或直接吩咐我记任务。";
  }
}

/** 基于搜索结果的回答生成（搜索工具后的第二阶段, 引用来源）。 */
const SEARCH_ANSWER_SYSTEM = `你是 TodoList AI 的 AI 助手。用户问了一个需要联网的问题，以下是搜索到的资料。
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
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const planStatus: ChatContext["planStatus"] = !plan
    ? "none"
    : plan.status === "reviewed"
      ? "reviewed"
      : plan.status;
  const blockCount = plan?.data?.timeBlocks.length ?? 0;

  // 无当前会话时自动新建（ChatGPT 打开即有一个新对话）
  useEffect(() => {
    if (currentConversationId == null && !busyRef.current) {
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
    return list.slice(-8).map((m) => ({ role: m.role, content: m.content }));
  }, [msgs]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: qk.plan(today) });
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
          return `规划失败了：${res.error}。请到「设置」里检查模型与 API 配置。`;
        }
        const n = res.plan?.data?.timeBlocks.length ?? 0;
        return `已生成今日计划草稿（${n} 个时间块），确认无误后点右侧「确认计划」，或继续让我调整。`;
      }
      case "add_task": {
        const title = intent.taskTitle || raw.replace(/^加(?:个)?任务[:：]?\s*/, "").trim();
        if (!title) return "没听清要记什么任务，试试「加任务：买咖啡」。";
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
        // 今天且给了时刻、今日已有计划（草稿/已确认）→ 插入计划时间块（按时间排序）
        let insertedBlock = false;
        if (scheduledDate === today && start && taskId > 0 && plan?.data) {
          const blocks = plan.data.timeBlocks ?? [];
          const next = [
            ...blocks,
            {
              key: `task:${taskId}`,
              title,
              start,
              end: end ?? addMinutesToHHmm(start, 60),
              priority: "medium" as const,
              effort: "1小时",
              taskId,
              done: false,
            },
          ].sort((a, b) => a.start.localeCompare(b.start));
          await updateBlocks.mutateAsync({ plan, blocks: next });
          insertedBlock = true;
        }
        const when =
          scheduledDate === today
            ? "今天"
            : scheduledDate === tomorrowStr()
              ? "明天"
              : scheduledDate ?? "";
        if (insertedBlock) {
          return `已把「${title}」排进今日计划 ${start}–${end} ✅（右侧时间块已更新）`;
        }
        if (when) {
          return `已把「${title}」排到 ${when}${start ? ` ${start}–${end}` : ""}（右侧「其他待办」可见）`;
        }
        return `已把「${title}」加入 Inbox，之后的每日规划会帮你安排它。`;
      }
      case "complete": {
        const t = findTask(intent.taskTitle, tasks, inboxTasks);
        if (!t) return `没有找到「${intent.taskTitle}」相关的任务。`;
        await toggleTask.mutateAsync({ id: t.id, done: true });
        invalidateAll();
        return `已完成「${t.title}」，干得漂亮 🎉`;
      }
      case "reschedule": {
        const t = findTask(intent.taskTitle, tasks, inboxTasks);
        if (!t) return `没有找到「${intent.taskTitle}」相关的任务。`;
        const target = parseTarget(intent.target);
        await updateTask.mutateAsync({
          id: t.id,
          scheduledDate: target,
          timeBlockStart: null,
          timeBlockEnd: null,
        });
        invalidateAll();
        const label = target === today ? "今天" : target === tomorrowStr() ? "明天" : target;
        return `已把「${t.title}」改到 ${label}。`;
      }
      case "delete": {
        const t = findTask(intent.taskTitle, tasks, inboxTasks);
        if (!t) return `没有找到「${intent.taskTitle}」相关的任务。`;
        await deleteTask.mutateAsync(t.id);
        invalidateAll();
        return `已删除「${t.title}」。`;
      }
      case "general": {
        // pi 式工具调用: 模型判断需要搜索 → 执行 DuckDuckGo → 结果交给模型回答
        if (intent.needsSearch === "yes" && intent.searchQuery) {
          const { results, engine, error } = await webSearch(intent.searchQuery, 5);
          if (results.length > 0) {
            const answer = await generatePlainText({
              settings,
              system: SEARCH_ANSWER_SYSTEM,
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
          return (
            `搜索「${intent.searchQuery}」没有结果${error ? `（${error.split("\n")[1] ?? ""}）` : ""}。` +
            "换个说法试试，或告诉我具体想了解什么。"
          );
        }
        return intent.reply || "收到。";
      }
    }
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setInput("");
    setBusy(true);
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

      const ctx: ChatContext = {
        date: today,
        planStatus,
        blockCount,
        todayTasks: todayTasks ?? [],
        inboxTasks: inbox ?? [],
      };
      const intent = await runChatAgent(text, ctx, settings, [
        ...historyForModel,
        { role: "user", content: text },
      ]);
      const reply = await execute(intent, text);
      await addMessage.mutateAsync({ conversationId: convId, role: "ai", content: reply });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "发送失败");
      const convId = currentConversationId;
      if (convId != null) {
        await addMessage.mutateAsync({
          conversationId: convId,
          role: "ai",
          content: `出错了：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const chips = [
    { label: "规划今天", cmd: "规划今天" },
    { label: "加任务", cmd: "加任务：" },
    { label: "重新规划", cmd: "重新规划" },
  ];

  const chipClick = (cmd: string) => {
    if (cmd === "加任务：") {
      // 预填输入框，让用户补全任务名（避免发送空指令）
      setInput(cmd);
    } else {
      send(cmd);
    }
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
          AI 助手
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          对话式操作：规划 / 加任务 / 顺延 / 完成
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
              {greeting(planStatus, blockCount)}
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
                {m.content}
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
              <span className="text-[12px] text-muted-foreground">思考中…</span>
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
            placeholder="对 AI 说：加任务：买咖啡 / 把报告顺延到明天…"
            className="h-9 bg-card text-[13px]"
          />
          <Button
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => send()}
            disabled={busy || !input.trim()}
            aria-label="发送"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
