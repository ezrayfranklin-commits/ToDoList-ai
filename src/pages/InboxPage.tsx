// Inbox 页：零成本收集想法（规划 §1.2），可拖拽排序、编辑、一键交给 AI。

import { useState } from "react";
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
import { GripVertical, Plus, Send, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  useCreateTask,
  useInboxTasks,
  useReorderTasks,
  useToggleTask,
} from "@/hooks/queries";
import { useUI } from "@/store/ui";
import { runPlanning } from "@/lib/agent";
import { todayStr } from "@/lib/dates";
import { TaskRow } from "@/components/TaskRow";
import type { Task } from "@/lib/types";

function SortableInboxRow({
  task,
  onToggle,
  onClick,
}: {
  task: Task;
  onToggle: (done: boolean) => void;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(task.id) });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <div className={isDragging ? "opacity-40" : ""}>
        <TaskRow
          task={task}
          onToggle={onToggle}
          onClick={onClick}
          dragHandle={
            <button
              className="cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground"
              {...attributes}
              {...listeners}
              aria-label="拖拽排序"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          }
        />
      </div>
    </div>
  );
}

export function InboxPage() {
  const { data: inbox, isLoading } = useInboxTasks();
  const createTask = useCreateTask();
  const reorder = useReorderTasks();
  const toggleTask = useToggleTask();
  const { openTaskDialog } = useUI();
  const [text, setText] = useState("");
  const [planning, setPlanning] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    await createTask.mutateAsync({ title: t, status: "inbox", source: "inbox" });
    setText("");
    toast.success("已收集到 Inbox");
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id || !inbox) return;
    const oldIndex = inbox.findIndex((t) => String(t.id) === active.id);
    const newIndex = inbox.findIndex((t) => String(t.id) === over.id);
    const next = arrayMove(inbox, oldIndex, newIndex);
    reorder.mutate(next.map((t) => t.id));
  };

  const handToAgent = async () => {
    setPlanning(true);
    const res = await runPlanning(todayStr());
    setPlanning(false);
    if (res.ok) toast.success("AI 已处理 Inbox 并生成今日计划");
    else toast.error(`规划失败：${res.error}`);
  };

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-6 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Inbox</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            零成本收集想法，之后交给 AI 归类排期
          </p>
        </div>
        {(inbox?.length ?? 0) > 0 && (
          <Button variant="outline" onClick={handToAgent} disabled={planning} className="gap-1.5">
            {planning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            交给 AI 归类
          </Button>
        )}
      </div>

      <div className="mb-4 flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="随手记下想法，回车加入 Inbox…"
          onKeyDown={(e) => e.key === "Enter" && add()}
          className="bg-card"
        />
        <Button onClick={add} disabled={!text.trim()} className="gap-1.5">
          <Plus className="h-4 w-4" />
          添加
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (inbox?.length ?? 0) === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-lg">
              📥
            </div>
            <p className="text-[13px] font-medium">Inbox 是空的</p>
            <p className="text-[12px] text-muted-foreground">
              想到什么先记下来，AI 会在每日规划时帮你归类
            </p>
          </CardContent>
        </Card>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={inbox!.map((t) => String(t.id))} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
              {inbox!.map((t) => (
                <SortableInboxRow
                  key={t.id}
                  task={t}
                  onToggle={(done) => {
                    if (done) {
                      // completing from inbox = done directly
                      toggleTask.mutate({ id: t.id, done });
                    }
                  }}
                  onClick={() => openTaskDialog(t.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
