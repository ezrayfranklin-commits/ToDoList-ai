// 今日计划页 (规划 §4.1) — 首页布局:
//   中间: AI 对话面板全占满
//   右侧: 今日规划竖边栏（时间块列表 + 其他待办）
// 流程: AI 生成 → 确认 → 执行（勾选/拖拽/增删）。

import { useMemo, useState } from "react";
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
import {
  CalendarDays,
  GripVertical,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  useOpenTasks,
  usePlan,
  useTasksByDate,
  useToggleTask,
  useUpdatePlanBlocks,
} from "@/hooks/queries";
import { applyPlanToDb, planDoneCount, planProgress, planTotalCount } from "@/lib/ai/plan";
import { runPlanning } from "@/lib/agent";
import { displayDate, todayStr } from "@/lib/dates";
import { useUI } from "@/store/ui";
import { PriorityBadge } from "@/components/TaskRow";
import { TodayChat } from "@/components/TodayChat";
import type { DailyPlan, TimeBlock } from "@/lib/types";
import { cn } from "@/lib/utils";

function SortableBlock({
  block,
  onToggle,
  onClick,
}: {
  block: TimeBlock;
  onToggle: (done: boolean) => void;
  onClick: () => void;
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
      <div className="w-[72px] shrink-0 text-[11px] font-medium tabular-nums text-foreground">
        {block.start}
        <span className="text-muted-foreground">–{block.end}</span>
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
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);

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

  const done = planDoneCount({ ...plan!, data: plan?.data ?? null } as DailyPlan);
  const total = planTotalCount({ ...plan!, data: plan?.data ?? null } as DailyPlan);
  const progress = planProgress({ ...plan!, data: plan?.data ?? null } as DailyPlan);
  const backlogCount = openTasks?.length ?? 0;

  const planNow = async () => {
    setPlanning(true);
    const res = await runPlanning(today);
    setPlanning(false);
    if (res.ok) toast.success("AI 已生成今日计划草稿");
    else toast.error(`规划失败：${res.error}`);
  };

  const confirmPlan = async () => {
    if (!plan?.data) return;
    setApplying(true);
    try {
      await applyPlanToDb(plan);
      toast.success("计划已确认并写入任务清单 ✅");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "确认失败");
    } finally {
      setApplying(false);
    }
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

      {/* 右侧: 今日规划竖边栏 */}
      <aside className="flex w-[330px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-background px-4 py-4">
        {/* Header: 日期 + 一键规划 */}
        <div>
          <h1 className="text-[15px] font-bold tracking-tight">今日规划</h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {displayDate(new Date())}
            <span className="mx-1.5">·</span>
            待办池 {backlogCount} 项
          </p>
        </div>

        <Button onClick={planNow} disabled={planning} className="w-full gap-1.5">
          {planning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {planning ? "规划中…" : "一键规划"}
        </Button>

        {/* 计划状态（确认环节, 规划 §4.1） */}
        {plan?.status === "draft" && (
          <Card className="border-accent/30 bg-accent/[0.04]">
            <CardContent className="flex flex-col gap-2.5 py-3">
              <p className="text-[12px] leading-relaxed">
                <span className="font-medium">AI 已生成 {total} 个时间块</span>
                <span className="text-muted-foreground">，可先拖拽调整再确认。</span>
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={planNow}
                  disabled={planning}
                  className="flex-1"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> 重新生成
                </Button>
                <Button size="sm" onClick={confirmPlan} disabled={applying} className="flex-1">
                  {applying ? "写入中…" : "确认计划"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {plan?.status === "confirmed" && (
          <Card>
            <CardContent className="py-3">
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="font-medium">
                  今日进度 {done}/{total}
                </span>
                <span className="tabular-nums text-muted-foreground">{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5" />
              <Button
                size="sm"
                variant="ghost"
                onClick={planNow}
                disabled={planning}
                className="mt-2 h-7 w-full text-[12px] text-muted-foreground"
              >
                <RefreshCw className="h-3 w-3" /> 重新规划
              </Button>
            </CardContent>
          </Card>
        )}

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
                        : toast.info("该时间块尚未关联任务，确认计划后自动创建")
                    }
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
                <div
                  key={t.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-zinc-300"
                  onClick={() => openTaskDialog(t.id)}
                >
                  <div className="min-w-0 flex-1 truncate text-[12.5px]">{t.title}</div>
                  <PriorityBadge priority={t.priority} />
                </div>
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
      </aside>
    </div>
  );
}
