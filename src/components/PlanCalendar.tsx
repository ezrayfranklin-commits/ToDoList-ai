// 日历弹窗（v0.12）: 右侧栏「日历」按钮打开。
// 上部: 月历, 有规划/任务的日期显示小圆点（has-plan-dot）。
// 下部: 选中日期的规划详情, 支持增删改查:
//   查: 时间块列表（时间/优先级/状态）+ 备注 + 其他待办
//   增: 标题 + 可选时间 → 建任务并入当日计划块
//   改: 勾选完成 / 点击块打开全局 TaskDialog 编辑
//   删: 块上删除按钮（删任务 + 移出计划块）
// 组件全部由 shadcn/ui 拼装（Dialog/Calendar/Input/Button/Badge）。

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarDays, Loader2, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  qk,
  useCreateTask,
  useDeleteTask,
  usePlan,
  usePlans,
  useTasks,
  useTasksByDate,
  useToggleTask,
} from "@/hooks/queries";
import { setPlanBlockDone, removePlanBlock, upsertTodayPlanBlock } from "@/lib/planBlocks";
import { addMinutesToHHmm, parseTimeHint } from "@/lib/ai/chat";
import { todayStr } from "@/lib/dates";
import { useUI } from "@/store/ui";
import { PriorityBadge } from "@/components/TaskRow";
import type { TimeBlock } from "@/lib/types";
import { cn } from "@/lib/utils";
import { t, dateLocale, isZh } from "@/lib/i18n";

export function PlanCalendar({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const today = todayStr();
  const qc = useQueryClient();
  const { openTaskDialog } = useUI();
  const { data: plans } = usePlans();
  const { data: tasks } = useTasks();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const { data: plan } = usePlan(selectedDate);
  const { data: dayTasks } = useTasksByDate(selectedDate);
  const createTask = useCreateTask();
  const toggleTask = useToggleTask();
  const deleteTask = useDeleteTask();

  // 新增表单
  const [newTitle, setNewTitle] = useState("");
  const [withTime, setWithTime] = useState(false);
  const [newTime, setNewTime] = useState("09:00");
  const [adding, setAdding] = useState(false);

  // 打开弹窗时默认选中今天
  useEffect(() => {
    if (open) setSelectedDate(today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 有规划/任务的日期集合 → 日历小点
  const planDates = useMemo(() => {
    const s = new Set<string>();
    (plans ?? []).forEach((p) => s.add(p.planDate));
    (tasks ?? []).forEach((t) => {
      if (t.scheduledDate) s.add(t.scheduledDate);
    });
    return s;
  }, [plans, tasks]);

  const blocks = plan?.data?.timeBlocks ?? [];
  const blockTaskIds = useMemo(
    () => new Set(blocks.map((b) => b.taskId).filter((x): x is number => x != null)),
    [blocks],
  );
  const orphanTasks =
    (dayTasks ?? []).filter((t) => t.status !== "done" && !blockTaskIds.has(t.id)) ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.plan(selectedDate) });
    qc.invalidateQueries({ queryKey: qk.tasks });
    qc.invalidateQueries({ queryKey: qk.plans });
  };

  /** 增: 新任务（可带时间 → 并入当日计划块） */
  const addTask = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      const start = withTime ? (parseTimeHint(newTime) ?? "09:00") : null;
      const end = start ? addMinutesToHHmm(start, 60) : null;
      const res = await createTask.mutateAsync({
        title,
        status: "scheduled",
        scheduledDate: selectedDate,
        timeBlockStart: start,
        timeBlockEnd: end,
        source: "manual",
      });
      const taskId = Number(res.lastInsertId ?? 0);
      if (start && taskId > 0) {
        await upsertTodayPlanBlock(
          {
            key: `task:${taskId}`,
            title,
            start,
            end: end ?? addMinutesToHHmm(start, 60),
            priority: "medium",
            effort: t("effort.1h"),
            taskId,
            done: false,
          },
          selectedDate,
        );
      }
      invalidate();
      setNewTitle("");
      toast.success(t("calendar.added", { title }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("calendar.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  /** 改: 勾选完成/取消（同步任务状态 + 计划块 done） */
  const toggleBlock = async (b: TimeBlock, done: boolean) => {
    if (b.taskId != null) {
      await setPlanBlockDone(selectedDate, b.taskId, done);
      await toggleTask.mutateAsync({ id: b.taskId, done });
      invalidate();
    }
  };

  /** 删: 删除任务 + 移出计划块 */
  const removeBlock = async (b: TimeBlock) => {
    if (b.taskId != null) {
      await deleteTask.mutateAsync(b.taskId);
      await removePlanBlock(selectedDate, b.taskId);
      invalidate();
      toast.success(t("calendar.deleted"));
    }
  };

  const isToday = selectedDate === today;
  const dateLabel = format(
    new Date(selectedDate + "T00:00:00"),
    isZh() ? "yyyy年M月d日 EEEE" : "EEE, MMM d, yyyy",
    { locale: dateLocale() },
  );
  const dateLabelShort = format(new Date(selectedDate + "T00:00:00"), "MMM d", {
    locale: dateLocale(),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            {t("calendar.title")}
            <span className="text-[11px] font-normal text-muted-foreground">
              {t("calendar.hint")}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[280px_1fr]">
          {/* 日历（有规划日期带小点） */}
          <div>
            <Calendar
              mode="single"
              selected={new Date(selectedDate + "T00:00:00")}
              onSelect={(d) => d && setSelectedDate(format(d, "yyyy-MM-dd"))}
              modifiers={{ hasPlan: [...planDates].map((d) => new Date(d + "T00:00:00")) }}
              modifiersClassNames={{ hasPlan: "has-plan-dot" }}
              className="rounded-lg border border-border bg-card p-2"
            />
          </div>

          {/* 选中日期详情 */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold">{dateLabel}</span>
                {isToday && (
                  <Badge className="border-accent/30 bg-accent/10 text-[10px] text-accent">
                    {t("calendar.today")}
                  </Badge>
                )}
              </div>
              <Badge variant="secondary" className="text-[10px]">
                {t("calendar.blocks", { count: blocks.length })}
              </Badge>
            </div>

            {/* 时间块列表 */}
            <div className="flex flex-col gap-1.5">
              {blocks.length === 0 ? (
                <p className="py-3 text-center text-[12px] text-muted-foreground">
                  {t("calendar.noPlan")}
                </p>
              ) : (
                blocks.map((b) => (
                  <div
                    key={b.key}
                    className="group flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
                  >
                    <button
                      className={cn(
                        "h-4 w-4 shrink-0 rounded-[4px] border transition-colors",
                        b.done ? "border-accent bg-accent" : "border-zinc-300 hover:border-accent",
                      )}
                      onClick={() => toggleBlock(b, !b.done)}
                      aria-label={t("calendar.markDone")}
                    >
                      {b.done && (
                        <svg viewBox="0 0 16 16" className="h-4 w-4 text-white" fill="none">
                          <path
                            d="M3.5 8.5l3 3 6-6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </button>
                    <div className="w-[72px] shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                      {b.start}–{b.end}
                    </div>
                    <button
                      className={cn(
                        "min-w-0 flex-1 truncate text-left text-[12.5px]",
                        b.done && "text-muted-foreground line-through",
                      )}
                      onClick={() =>
                        b.taskId != null
                          ? openTaskDialog(b.taskId)
                          : toast.info(t("calendar.blockNoTask"))
                      }
                      title={t("calendar.edit")}
                    >
                      {b.title}
                    </button>
                    <PriorityBadge priority={b.priority} />
                    <button
                      onClick={() => removeBlock(b)}
                      className="hidden shrink-0 text-muted-foreground/50 hover:text-destructive group-hover:block"
                      aria-label={t("calendar.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* 计划备注 */}
            {plan?.data?.notes && (
              <p className="rounded-lg bg-secondary/60 px-3 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {plan.data.notes}
              </p>
            )}

            {/* 其他待办（该日未排时间的任务） */}
            {orphanTasks.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {t("calendar.otherTasks", { count: orphanTasks.length })}
                </div>
                <div className="flex flex-col gap-1.5">
                  {orphanTasks.map((t) => (
                    <div
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
                      onClick={() => openTaskDialog(t.id)}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{t.title}</span>
                      <PriorityBadge priority={t.priority} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 增: 添加任务 */}
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-zinc-300 p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addTask()}
                  placeholder={`${t("calendar.addHere", { date: isToday ? t("calendar.today") : dateLabelShort })}`}
                  className="h-8 flex-1 text-[12.5px]"
                />
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={withTime}
                    onChange={(e) => setWithTime(e.target.checked)}
                    className="h-3 w-3 accent-[#4a6cf7]"
                  />
                  {t("calendar.time")}
                </label>
                {withTime && (
                  <Input
                    type="time"
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                    className="h-8 w-[92px] shrink-0 text-[12px] tabular-nums"
                  />
                )}
                <Button
                  size="sm"
                  className="h-8 shrink-0 gap-1"
                  onClick={addTask}
                  disabled={adding || !newTitle.trim()}
                >
                  {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  {t("calendar.add")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
