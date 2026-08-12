// Sidebar navigation + today progress (规划 §5 浅色极简).

import { CalendarCheck2, Inbox, ListChecks, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUI, type View } from "@/store/ui";
import { usePlan, useTasksByDate } from "@/hooks/queries";
import { planProgress, planDoneCount, planTotalCount } from "@/lib/ai/plan";
import { todayStr } from "@/lib/dates";
import { Progress } from "@/components/ui/progress";

const NAV: Array<{ view: View; label: string; icon: typeof Inbox }> = [
  { view: "today", label: "今日计划", icon: CalendarCheck2 },
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "review", label: "复盘", icon: ListChecks },
  { view: "settings", label: "设置", icon: Settings },
];

export function Sidebar() {
  const { view, setView } = useUI();
  const today = todayStr();
  const { data: plan } = usePlan(today);
  const { data: todayTasks } = useTasksByDate(today);

  const progress = plan?.data ? planProgress(plan) : 0;
  const done = plan?.data ? planDoneCount(plan) : 0;
  const total = plan?.data ? planTotalCount(plan) : 0;
  const taskDone = todayTasks?.filter((t) => t.status === "done").length ?? 0;
  const taskTotal = todayTasks?.length ?? 0;

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar px-3 py-5">
      <div className="mb-6 flex items-center gap-2 px-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <div>
          <div className="text-[13px] font-semibold leading-tight">TodoList AI</div>
          <div className="text-[11px] text-muted-foreground">每日 AI 规划</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1">
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

      <div className="mt-auto rounded-xl border border-border bg-card p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">今日进度</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {plan ? `${done}/${total}` : `${taskDone}/${taskTotal}`}
          </span>
        </div>
        <Progress value={plan ? progress : taskTotal ? Math.round((taskDone / taskTotal) * 100) : 0} className="h-1.5" />
        {!plan && taskTotal === 0 && (
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            点击 ⌘K 或「一键规划」开始
          </p>
        )}
      </div>
    </aside>
  );
}
