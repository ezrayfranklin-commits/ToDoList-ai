// Task create/edit dialog (shadcn Dialog + Input + Textarea + Select + Calendar).

import { useEffect, useState } from "react";
import { format, parse } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { toast } from "sonner";
import { useUI } from "@/store/ui";
import { useCreateTask, useDeleteTask, useUpdateTask, useTasks } from "@/hooks/queries";
import type { Priority } from "@/lib/types";
import { t } from "@/lib/i18n";

export function TaskDialog() {
  const { taskDialog, closeTaskDialog } = useUI();
  const { data: tasks } = useTasks();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const editing = taskDialog.taskId != null
    ? tasks?.find((t) => t.id === taskDialog.taskId)
    : null;

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [withTime, setWithTime] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (taskDialog.open) {
      setTitle(editing?.title ?? "");
      setNotes(editing?.notes ?? "");
      setPriority(editing?.priority ?? "medium");
      setDate(editing?.scheduledDate ? new Date(editing.scheduledDate + "T00:00:00") : undefined);
      setStart(editing?.timeBlockStart ?? "09:00");
      setEnd(editing?.timeBlockEnd ?? "10:00");
      setWithTime(Boolean(editing?.timeBlockStart));
    }
  }, [taskDialog.open, taskDialog.taskId, editing]);

  const close = () => closeTaskDialog();

  const save = async () => {
    const trimmed = title.trim();
    if (!t) return;
    setSaving(true);
    const scheduledDate = date ? format(date, "yyyy-MM-dd") : null;
    const timeBlockStart = withTime ? start : null;
    const timeBlockEnd = withTime ? end : null;
    try {
      if (editing) {
        await updateTask.mutateAsync({
          id: editing.id,
          title: trimmed,
          notes: notes || null,
          priority,
          scheduledDate,
          timeBlockStart,
          timeBlockEnd,
        });
        toast.success(t("task.updated"));
      } else {
        await createTask.mutateAsync({
          title: trimmed,
          notes: notes || undefined,
          priority,
          status: scheduledDate ? "scheduled" : "inbox",
          scheduledDate,
          source: "manual",
        });
        toast.success(t("task.addedInbox"));
      }
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("task.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    await deleteTask.mutateAsync(editing.id);
    toast.success(t("task.deleted"));
    close();
  };

  return (
    <Dialog open={taskDialog.open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? t("task.edit") : t("task.new")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-title">{t("task.title")}</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("task.titlePlaceholder")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-notes">{t("task.notes")}</Label>
            <Textarea
              id="task-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("task.notesPlaceholder")}
              rows={2}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t("task.priority")}</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">{t("task.high")}</SelectItem>
                <SelectItem value="medium">{t("task.medium")}</SelectItem>
                <SelectItem value="low">{t("task.low")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t("task.date")}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start font-normal">
                  {date ? format(date, "yyyy-MM-dd") : t("task.noDate")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={(d) => setDate(d)}
                />
                <div className="flex gap-2 border-t p-2">
                  <Button variant="ghost" size="sm" className="flex-1" onClick={() => setDate(undefined)}>
                    {t("task.clear")}
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => setDate(new Date())}>
                    {t("task.today")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          {date && (
            <div className="flex flex-col gap-2">
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={withTime}
                  onChange={(e) => setWithTime(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[#4a6cf7]"
                />
                {t("task.withTime")}
              </Label>
              {withTime && (
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="tabular-nums"
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className="tabular-nums"
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={remove}>
              {t("task.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={close}>
              {t("task.cancel")}
            </Button>
            <Button onClick={save} disabled={saving || !title.trim()}>
              {saving ? t("task.saving") : t("task.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
