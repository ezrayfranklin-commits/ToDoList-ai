// 今日计划页 (规划 §4.1) — 首页布局:
//   中间: AI 对话面板全占满
//   右侧: 今日规划竖边栏（时间块列表 + 其他待办）
// 流程: AI 生成 → 确认 → 执行（勾选/拖拽/增删）。
// 特效 (v0.9): 超过结束时间仍未完成的时间块 → 七彩光环闪烁提醒。

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays, GripVertical, Inbox, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  useOpenTasks,
  usePlan,
  useTasksByDate,
  useToggleTask,
  useUpdatePlanBlocks,
} from "@/hooks/queries";
import { displayDate, todayStr } from "@/lib/dates";
import { useUI } from "@/store/ui";
import { PriorityBadge, TaskRow } from "@/components/TaskRow";
import { TodayChat } from "@/components/TodayChat";
import { PlanCalendar } from "@/components/PlanCalendar";
import type { TimeBlock } from "@/lib/types";
import { cn } from "@/lib/utils";

function SortableBlock({
  block,
  onToggle,
  onClick,
  overdue,
}: {
  block: TimeBlock;
  onToggle: (done: boolean) => void;
  onClick: () => void;
  overdue: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.key });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 transition-shadow",
        isDragging ? "z-10 border-accent/50 shadow-md" : "border-border hover:border-zinc-300",
        overdue && "overdue-ring border-transparent",
      )}
    >
      <button
        className="cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground"
        {...attributes}
        {...listeners}
        aria-label="拖拽排序"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div
        className={cn(
          "w-[72px] shrink-0 text-[11px] font-medium tabular-nums text-foreground",
          overdue && "overdue-time",
        )}
      >
        {block.start}
        <span className={cn("text-muted-foreground", overdue && "!text-red-500")}>–{block.end}</span>
      </div>
      <button
        className={cn(
          "h-4 w-4 shrink-0 rounded-[4px] border transition-colors",
          block.done ? "border-accent bg-accent" : "border-zinc-300 hover:border-accent",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(!block.done);
        }}
        aria-label="标记完成"
      >
        {block.done && (
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-white" fill="none">
            <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "cursor-pointer truncate text-[12.5px]",
            block.done && "text-muted-foreground line-through",
          )}
          onClick={onClick}
        >
          {block.title}
        </div>
        {block.effort && !block.done && (
          <div className="text-[10.5px] text-muted-foreground">{block.effort}</div>
        )}
        {overdue && !block.done && (
          <div className="text-[10px] font-medium text-red-500">⏰ 已超时，记得点勾完成</div>
        )}
      </div>
      <PriorityBadge priority={block.priority} />
    </div>
  );
}

export function TodayPage() {
  const today = todayStr();
  const { data: plan, isLoading: planLoading } = usePlan(today);
  const { data: todayTasks } = useTasksByDate(today);
  const { data: openTasks } = useOpenTasks();
  const toggleTask = useToggleTask();
  const updateBlocks = useUpdatePlanBlocks();
  const { openTaskDialog, setView } = useUI();
  const [calendarOpen, setCalendarOpen] = useState(false);
  // 当前时间（30s 刷新一次，用于超时判定）
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const blocks = useMemo(() => plan?.data?.timeBlocks ?? [], [plan]);

  // tasks scheduled today that are NOT inside any plan block
  const orphanTasks = useMemo(() => {
    const blockTaskIds = new Set(
      blocks.map((b) => b.taskId).filter((id): id is number => id != null),
    );
    return (todayTasks ?? []).filter(
      (t) => t.status !== "done" && !blockTaskIds.has(t.id),
    );
  }, [todayTasks, blocks]);

  const backlogCount = openTasks?.length ?? 0;

  // 超时判定: 未完成 且 当前时间已超过块结束时间.
  // 跨零点块 (start > end, 如 23:00-00:00) 的结束时间按次日算,
  // 否则今晚 23:00 的块会被 "16:22 > 00:00" 误判为超时
  const isOverdue = (b: TimeBlock): boolean => {
    if (b.done || !b.end) return false;
    const [eh, em] = b.end.split(":").map(Number);
    if (Number.isNaN(eh) || Number.isNaN(em)) return false;
    const endD = new Date(now);
    endD.setHours(eh, em, 0, 0);
    const [sh, sm] = (b.start ?? "").split(":").map(Number);
    if (!Number.isNaN(sh) && !Number.isNaN(sm) && sh * 60 + sm >= eh * 60 + em) {
      endD.setDate(endD.getDate() + 1); // end 在次日
    }
    return now.getTime() > endD.getTime();
  };

  const toggleBlock = async (block: TimeBlock, done: boolean) => {
    if (!plan?.data) return;
    const next = blocks.map((b) => (b.key === block.key ? { ...b, done } : b));
    await updateBlocks.mutateAsync({ plan, blocks: next });
    if (block.taskId != null) {
      await toggleTask.mutateAsync({ id: block.taskId, done });
    }
  };

  const onDragEnd = async (e: DragEndEvent) => {
    if (!plan?.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = blocks.findIndex((b) => b.key === active.id);
    const newIndex = blocks.findIndex((b) => b.key === over.id);
    const next = arrayMove(blocks, oldIndex, newIndex);
    await updateBlocks.mutateAsync({ plan, blocks: next });
  };

  return (
    <div className="flex h-full min-h-0">
      {/* 中间: AI 对话面板（全占满） */}
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <TodayChat />
      </div>

      {/* 右侧: 今日规划竖边栏（与左侧、中间融为一体，无边框分隔） */}
      {/* 结构: 顶部冻结区(标题+日历按钮) + 下方独立滚动区, 滚动时日历始终可点 */}
      <aside className="flex w-[330px] shrink-0 flex-col px-4 py-4">
        {/* 冻结区: 标题 + 日历按钮(不随下面内容滚动) */}
        <div className="flex shrink-0 flex-col gap-3 pb-3">
        <div>
          <h1 className="text-[15px] font-bold tracking-tight">今日规划</h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {displayDate(new Date())}
            <span className="mx-1.5">·</span>
            待办池 {backlogCount} 项
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() => setCalendarOpen(true)}
          className="w-full gap-1.5"
        >
          <CalendarDays className="h-4 w-4" />
          日历
        </Button>

        <PlanCalendar open={calendarOpen} onOpenChange={setCalendarOpen} />
        </div>

        {/* 可滚动区: 时间块列表 / 备注 / 其他待办 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col gap-3">
        {/* 时间块列表 */}
        {planLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : blocks.length > 0 ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={blocks.map((b) => b.key)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-2">
                {blocks.map((b) => (
                  <SortableBlock
                    key={b.key}
                    block={b}
                    onToggle={(d) => toggleBlock(b, d)}
                    onClick={() =>
                      b.taskId != null
                        ? openTaskDialog(b.taskId)
                        : toast.info("该时间块尚未关联任务")
                    }
                    overdue={isOverdue(b)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <Card className="py-8">
            <CardContent className="flex flex-col items-center gap-2.5 text-center">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary">
                <CalendarDays className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-[12.5px] font-medium">今天还没有计划</p>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  对中间的 AI 说「规划今天」，或点上方按钮
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 计划备注 */}
        {plan?.data?.notes && (
          <p className="rounded-lg bg-secondary/60 px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {plan.data.notes}
          </p>
        )}

        {/* 其他待办（不在计划块内的今日任务） */}
        {orphanTasks.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[12.5px] font-semibold">其他待办</h2>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {orphanTasks.length}
              </Badge>
            </div>
            <div className="flex flex-col gap-2">
              {orphanTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={(done) => toggleTask.mutate({ id: t.id, done })}
                  onClick={() => openTaskDialog(t.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Inbox 引导 */}
        <button
          className="mt-auto flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 py-2.5 text-[11.5px] text-muted-foreground transition-colors duration-200 hover:border-accent hover:text-accent"
          onClick={() => setView("inbox")}
        >
          <Plus className="h-3.5 w-3.5" />
          新想法先丢进 Inbox
          <Inbox className="h-3.5 w-3.5" />
        </button>
        </div>
        </div>
      </aside>
    </div>
  );
}
