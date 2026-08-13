// ⌘K command palette (shadcn Command, Spotlight-like, 规划 §2.3).
// Quick-add inbox items + view jumps.

import { useMemo, useState } from "react";
import { CalendarCheck2, Inbox, ListChecks, Plus, Settings, Search } from "lucide-react";
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
import { t } from "@/lib/i18n";

export function CommandPalette() {
  const { paletteOpen, openPalette, setView, openTaskDialog } = useUI();
  const { data: inbox } = useInboxTasks();
  const createTask = useCreateTask();
  const [query, setQuery] = useState("");

  const quickAdd = useMemo(
    () => query.trim().length > 0 && !inbox?.some((t) => t.title === query.trim()),
    [query, inbox],
  );

  const addToInbox = async (title: string) => {
    await createTask.mutateAsync({ title, status: "inbox", source: "inbox" });
    toast.success(t("cmd.addedToInbox", { title }));
    setQuery("");
  };

  return (
    <CommandDialog open={paletteOpen} onOpenChange={openPalette}>
      <CommandInput
        placeholder={t("cmd.placeholder")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{t("cmd.empty")}</CommandEmpty>
        {quickAdd && (
          <CommandGroup heading={t("cmd.quickAdd")}>
            <CommandItem value={`add:${query}`} onSelect={() => addToInbox(query)}>
              <Plus className="h-4 w-4" />
              {t("cmd.addToInbox", { title: query })}
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading={t("cmd.inboxItems")}>
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
        <CommandGroup heading={t("cmd.actions")}>
          <CommandItem value="go:today" onSelect={() => { setView("today"); openPalette(false); }}>
            <CalendarCheck2 className="h-4 w-4" />
            {t("cmd.goToday")}
          </CommandItem>
          <CommandItem value="go:inbox" onSelect={() => { setView("inbox"); openPalette(false); }}>
            <Inbox className="h-4 w-4" />
            {t("cmd.goInbox")}
          </CommandItem>
          <CommandItem value="go:review" onSelect={() => { setView("review"); openPalette(false); }}>
            <ListChecks className="h-4 w-4" />
            {t("cmd.goReview")}
          </CommandItem>
          <CommandItem value="go:settings" onSelect={() => { setView("settings"); openPalette(false); }}>
            <Settings className="h-4 w-4" />
            {t("cmd.goSettings")}
          </CommandItem>
        </CommandGroup>
        <div className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <Search className="h-3 w-3" />
          {t("cmd.footer")}
        </div>
      </CommandList>
    </CommandDialog>
  );
}
