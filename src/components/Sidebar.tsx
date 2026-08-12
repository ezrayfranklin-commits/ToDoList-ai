// Sidebar: 顶部 logo + 新建对话，中部 ChatGPT 式会话历史列表，
// 底部今日进度。与中央对话区、右侧规划栏融为一体（无边框分隔，v0.3.1）。

import { CalendarCheck2, Inbox, ListChecks, Plus, Settings, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUI, type View } from "@/store/ui";
import { usePlan, useTasksByDate, useConversations, useCreateConversation, useDeleteConversation } from "@/hooks/queries";
import { planProgress, planDoneCount, planTotalCount } from "@/lib/ai/plan";
import { todayStr } from "@/lib/dates";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";

const NAV: Array<{ view: View; label: string; icon: typeof Inbox }> = [
  { view: "today", label: "今日计划", icon: CalendarCheck2 },
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "review", label: "复盘", icon: ListChecks },
  { view: "settings", label: "设置", icon: Settings },
];

export function Sidebar() {
  const { view, setView, currentConversationId, setCurrentConversation } = useUI();
  const today = todayStr();
  const { data: plan } = usePlan(today);
  const { data: todayTasks } = useTasksByDate(today);
  const { data: conversations } = useConversations();
  const createConversation = useCreateConversation();
  const deleteConversation = useDeleteConversation();

  const progress = plan?.data ? planProgress(plan) : 0;
  const done = plan?.data ? planDoneCount(plan) : 0;
  const total = plan?.data ? planTotalCount(plan) : 0;
  const taskDone = todayTasks?.filter((t) => t.status === "done").length ?? 0;
  const taskTotal = todayTasks?.length ?? 0;

  /** 新建对话并切换过去（ChatGPT 对应逻辑）。 */
  const newChat = async () => {
    const id = await createConversation.mutateAsync();
    setCurrentConversation(id);
    setView("today");
  };

  const removeChat = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    await deleteConversation.mutateAsync(id);
    if (currentConversationId === id) {
      // 删除当前会话后落到最新会话（若有）
      const rest = (conversations ?? []).filter((c) => c.id !== id);
      setCurrentConversation(rest[0]?.id ?? null);
    }
    toast.success("对话已删除");
  };

  return (
    <aside className="flex h-full w-56 flex-col px-3 py-5">
      {/* Logo + 新建对话 */}
      <div className="mb-4 flex items-center gap-2 px-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight">TodoList AI</div>
          <div className="text-[11px] text-muted-foreground">每日 AI 规划</div>
        </div>
      </div>

      <button
        onClick={newChat}
        className="mb-4 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        <Plus className="h-3.5 w-3.5" />
        新建对话
      </button>

      {/* ChatGPT 式会话历史 */}
      <div className="mb-1 px-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        对话历史
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-0.5">
        {(conversations ?? []).length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
            还没有对话。点「新建对话」开始，或直接对中央的 AI 说话。
          </p>
        ) : (
          (conversations ?? []).map((c) => {
            const active = c.id === currentConversationId;
            return (
              <button
                key={c.id}
                onClick={() => {
                  setCurrentConversation(c.id);
                  setView("today");
                }}
                className={cn(
                  "group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-200",
                  active
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.title}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => removeChat(e, c.id)}
                  onKeyDown={(e) => e.key === "Enter" && removeChat(e as unknown as React.MouseEvent, c.id)}
                  className="hidden shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-destructive group-hover:block"
                  aria-label="删除对话"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* 导航 */}
      <nav className="mb-4 mt-2 flex flex-col gap-1">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.view;
          return (
            <button
              key={item.view}
              onClick={() => setView(item.view)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-200",
                active
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* 今日进度 */}
      <div className="rounded-xl bg-card p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">今日进度</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {plan ? `${done}/${total}` : `${taskDone}/${taskTotal}`}
          </span>
        </div>
        <Progress
          value={plan ? progress : taskTotal ? Math.round((taskDone / taskTotal) * 100) : 0}
          className="h-1.5"
        />
        {!plan && taskTotal === 0 && (
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            点击 ⌘K 或「一键规划」开始
          </p>
        )}
      </div>
    </aside>
  );
}
