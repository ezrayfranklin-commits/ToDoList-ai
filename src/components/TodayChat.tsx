// Today page dialogue panel (首页对话面板, 需求: 对话框 + 待办清单并存).
// AI 气泡在左、用户气泡在右；指令执行后自动刷新下方待办列表。
// 组件全部由 shadcn/ui 现成组件拼装（Card/Input/Button + lucide 图标）。

import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageSquareText,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  qk,
  useCreateTask,
  useDeleteTask,
  useInboxTasks,
  usePlan,
  useTasksByDate,
  useToggleTask,
  useUpdateTask,
} from "@/hooks/queries";
import { runPlanning } from "@/lib/agent";
import { runChatAgent, findTask, parseTarget, type ChatContext } from "@/lib/ai/chat";
import { todayStr, tomorrowStr } from "@/lib/dates";
import { useSettings } from "@/store/settings";
import { cn } from "@/lib/utils";

interface ChatMsg {
  id: number;
  role: "user" | "ai";
  text: string;
  time: string;
}

let msgId = 0;

function greeting(planStatus: ChatContext["planStatus"], blockCount: number): string {
  switch (planStatus) {
    case "draft":
      return `AI 已生成今日计划草稿（${blockCount} 个时间块）。可以直接说「确认」，或让我「重新规划」；也可以拖拽下方时间块调整。`;
    case "confirmed":
      return "今日计划已确认，开工吧！可以随时对我说：「加任务：…」「把 … 顺延到明天」「完成 …」。";
    default:
      return "早上好！我是你的 AI 规划师。说「规划今天」，我读取你的待办与提醒事项来排今天的计划；也可以直接吩咐我记任务。";
  }
}

export function TodayChat() {
  const today = todayStr();
  const settings = useSettings();
  const qc = useQueryClient();
  const { data: plan } = usePlan(today);
  const { data: todayTasks } = useTasksByDate(today);
  const { data: inbox } = useInboxTasks();
  const createTask = useCreateTask();
  const toggleTask = useToggleTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const planStatus: ChatContext["planStatus"] = !plan
    ? "none"
    : plan.status === "reviewed"
      ? "reviewed"
      : plan.status;
  const blockCount = plan?.data?.timeBlocks.length ?? 0;

  const [msgs, setMsgs] = useState<ChatMsg[]>(() => [
    { id: ++msgId, role: "ai", text: greeting(planStatus, blockCount), time: format(new Date(), "HH:mm") },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const push = (role: "user" | "ai", text: string) => {
    setMsgs((prev) => [
      ...prev,
      { id: ++msgId, role, text, time: format(new Date(), "HH:mm") },
    ]);
  };

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: qk.plan(today) });
    qc.invalidateQueries({ queryKey: qk.tasks });
    qc.invalidateQueries({ queryKey: qk.openTasks });
  };

  /** Execute a structured intent, returning the reply to show. */
  const execute = async (intent: Awaited<ReturnType<typeof runChatAgent>>, raw: string): Promise<string> => {
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
        return `已生成今日计划草稿（${n} 个时间块），确认无误后点下方「确认计划」，或继续让我调整。`;
      }
      case "add_task": {
        const title = intent.taskTitle || raw.replace(/^加(?:个)?任务[:：]?\s*/, "").trim();
        if (!title) return "没听清要记什么任务，试试「加任务：买咖啡」。";
        await createTask.mutateAsync({ title, status: "inbox", source: "manual" });
        invalidateAll();
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
      case "general":
      default:
        return intent.reply || "收到。";
    }
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setInput("");
    push("user", text);
    setBusy(true);
    try {
      const ctx: ChatContext = {
        date: today,
        planStatus,
        blockCount,
        todayTasks: todayTasks ?? [],
        inboxTasks: inbox ?? [],
      };
      const intent = await runChatAgent(text, ctx, settings);
      const reply = await execute(intent, text);
      push("ai", reply);
    } catch (e) {
      push("ai", `出错了：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const chips = [
    { label: "规划今天", cmd: "规划今天" },
    { label: "加任务", cmd: "加任务：" },
    { label: "重新规划", cmd: "重新规划" },
  ];

  return (
    <Card className="mb-4 overflow-hidden">
      <button
        className="flex w-full items-center justify-between px-4 py-2.5 transition-colors duration-200 hover:bg-secondary/50"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <MessageSquareText className="h-3.5 w-3.5" />
          </span>
          AI 助手
        </span>
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="hidden sm:inline">对话式操作：规划 / 加任务 / 顺延 / 完成</span>
          {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </span>
      </button>

      {!collapsed && (
        <>
          <div
            ref={scrollRef}
            className="flex max-h-64 flex-col gap-2.5 overflow-y-auto border-t border-border bg-background/60 px-4 py-3"
          >
            {msgs.map((m) =>
              m.role === "ai" ? (
                <div key={m.id} className="flex items-end gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Sparkles className="h-3 w-3" />
                  </span>
                  <div className="max-w-[85%] rounded-xl rounded-bl-sm border border-border bg-card px-3 py-2 text-[13px] leading-relaxed shadow-sm">
                    {m.text}
                    <div className="mt-1 text-[10px] text-muted-foreground">{m.time}</div>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex items-end justify-end gap-2">
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-accent px-3 py-2 text-[13px] leading-relaxed text-accent-foreground shadow-sm">
                    {m.text}
                    <div className="mt-1 text-right text-[10px] text-accent-foreground/70">
                      {m.time}
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

          <div className="border-t border-border px-3 py-2.5">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <button
                  key={c.label}
                  onClick={() => send(c.cmd)}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
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
        </>
      )}
    </Card>
  );
}
