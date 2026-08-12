// ⌘K command palette (shadcn Command, Spotlight-like, 规划 §2.3).
// Quick-add inbox items + view jumps + one-click planning.

import { useMemo, useState } from "react";
import { CalendarCheck2, Inbox, ListChecks, Plus, Settings, Sparkles, Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useUI } from "@/store/ui";
import { useCreateTask, useInboxTasks } from "@/hooks/queries";
import { toast } from "sonner";
import { runPlanning } from "@/lib/agent";

export function CommandPalette() {
  const { paletteOpen, openPalette, setView, openTaskDialog } = useUI();
  const { data: inbox } = useInboxTasks();
  const createTask = useCreateTask();
  const [query, setQuery] = useState("");
  const [planning, setPlanning] = useState(false);

  const quickAdd = useMemo(
    () => query.trim().length > 0 && !inbox?.some((t) => t.title === query.trim()),
    [query, inbox],
  );

  const addToInbox = async (title: string) => {
    await createTask.mutateAsync({ title, status: "inbox", source: "inbox" });
    toast.success(`已加入 Inbox：「${title}」`);
    setQuery("");
  };

  const planNow = async () => {
    setPlanning(true);
    const res = await runPlanning();
    setPlanning(false);
    if (res.ok) {
      toast.success("今日计划已生成，请确认");
      setView("today");
    } else {
      toast.error(`规划失败：${res.error}`);
    }
    openPalette(false);
  };

  return (
    <CommandDialog open={paletteOpen} onOpenChange={openPalette}>
      <CommandInput
        placeholder="输入任务快速加入 Inbox，或搜索操作…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>没有匹配结果</CommandEmpty>
        {quickAdd && (
          <CommandGroup heading="快速添加">
            <CommandItem value={`add:${query}`} onSelect={() => addToInbox(query)}>
              <Plus className="h-4 w-4" />
              加入 Inbox：{query}
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Inbox 条目">
          {(inbox ?? []).slice(0, 5).map((t) => (
            <CommandItem
              key={t.id}
              value={`inbox:${t.title}`}
              onSelect={() => {
                openTaskDialog(t.id);
                openPalette(false);
              }}
            >
              <Inbox className="h-4 w-4" />
              {t.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="操作">
          <CommandItem value="plan:now" onSelect={planNow} disabled={planning}>
            <Sparkles className="h-4 w-4" />
            {planning ? "规划中…" : "一键规划今日"}
          </CommandItem>
          <CommandItem value="go:today" onSelect={() => { setView("today"); openPalette(false); }}>
            <CalendarCheck2 className="h-4 w-4" />
            前往今日计划
          </CommandItem>
          <CommandItem value="go:inbox" onSelect={() => { setView("inbox"); openPalette(false); }}>
            <Inbox className="h-4 w-4" />
            前往 Inbox
          </CommandItem>
          <CommandItem value="go:review" onSelect={() => { setView("review"); openPalette(false); }}>
            <ListChecks className="h-4 w-4" />
            前往复盘
          </CommandItem>
          <CommandItem value="go:settings" onSelect={() => { setView("settings"); openPalette(false); }}>
            <Settings className="h-4 w-4" />
            前往设置
          </CommandItem>
        </CommandGroup>
        <div className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <Search className="h-3 w-3" />
          Enter 添加 · 任意时刻按 ⌘K 唤起
        </div>
      </CommandList>
    </CommandDialog>
  );
}
