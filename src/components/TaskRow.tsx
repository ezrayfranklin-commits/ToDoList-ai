// Task row: checkbox + priority badge + time block (shadcn Checkbox/Card/Badge).

import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";
import { t } from "@/lib/i18n";

export const PRIORITY_META: Record<
  Task["priority"],
  { label: () => string; badge: string; dot: string }
> = {
  high: {
    label: () => t("priority.high"),
    badge: "border-red-200 bg-red-50 text-red-600",
    dot: "bg-red-500",
  },
  medium: {
    label: () => t("priority.medium"),
    badge: "border-amber-200 bg-amber-50 text-amber-600",
    dot: "bg-amber-500",
  },
  low: {
    label: () => t("priority.low"),
    badge: "border-zinc-200 bg-zinc-50 text-zinc-500",
    dot: "bg-zinc-400",
  },
};

export function PriorityBadge({ priority }: { priority: Task["priority"] }) {
  const meta = PRIORITY_META[priority];
  return (
    <Badge variant="outline" className={cn("h-5 gap-1 px-1.5 text-[10px] font-medium", meta.badge)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.label()}
    </Badge>
  );
}

export function TaskRow({
  task,
  onToggle,
  onClick,
  dragHandle,
  compact = false,
}: {
  task: Task;
  onToggle: (done: boolean) => void;
  onClick?: () => void;
  dragHandle?: React.ReactNode;
  compact?: boolean;
}) {
  const done = task.status === "done";
  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 transition-colors duration-200 hover:border-zinc-300",
        compact ? "py-2" : "py-2.5",
      )}
    >
      {dragHandle}
      <Checkbox
        checked={done}
        onCheckedChange={(v) => onToggle(Boolean(v))}
        onClick={(e) => e.stopPropagation()}
        aria-label={t("task.markDone")}
        className={cn("h-4 w-4", done && "border-accent bg-accent text-accent-foreground")}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-[13px]", done && "text-muted-foreground line-through")}>
          {task.title}
        </div>
        {(task.timeBlockStart || task.notes) && !compact && (
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            {task.timeBlockStart && (
              <span className="tabular-nums">
                {task.timeBlockStart}
                {task.timeBlockEnd ? `–${task.timeBlockEnd}` : ""}
              </span>
            )}
            {task.notes && <span className="truncate">{task.notes}</span>}
          </div>
        )}
      </div>
      <PriorityBadge priority={task.priority} />
    </div>
  );
}
