// App shell: layout + ⌘K + scheduler bootstrap + dialogs.

import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { TaskDialog } from "@/components/TaskDialog";
import { TodayPage } from "@/pages/TodayPage";
import { InboxPage } from "@/pages/InboxPage";
import { ReviewPage } from "@/pages/ReviewPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useUI } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { startScheduler, stopScheduler } from "@/lib/scheduler";
import { runPlanning, runReview } from "@/lib/agent";
import { todayStr } from "@/lib/dates";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1 },
  },
});

function Shell() {
  const { view, paletteOpen, openPalette } = useUI();
  const settings = useSettings();

  // ⌘K command palette (Spotlight-like)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, openPalette]);

  // Daily automation loop (08:00 plan / 21:00 review)
  useEffect(() => {
    if (!settings.loaded) return;
    startScheduler({
      onPlan: () => {
        if (settings.autoPlan) void runPlanning(todayStr());
      },
      onReview: () => {
        if (settings.autoReview) void runReview(todayStr());
      },
      enabled: () => settings.autoPlan || settings.autoReview,
    });
    return () => stopScheduler();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.loaded, settings.autoPlan, settings.autoReview]);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        {view === "today" && <TodayPage />}
        {view === "inbox" && <InboxPage />}
        {view === "review" && <ReviewPage />}
        {view === "settings" && <SettingsPage />}
      </main>
      <CommandPalette />
      <TaskDialog />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
