// UI state (Zustand, design doc §2.2).

import { create } from "zustand";

export type View = "today" | "inbox" | "review" | "settings";

interface UIState {
  view: View;
  paletteOpen: boolean;
  taskDialog: { open: boolean; taskId: number | null; inboxOnly?: boolean };
  setView: (v: View) => void;
  openPalette: (open?: boolean) => void;
  openTaskDialog: (taskId: number | null, opts?: { inboxOnly?: boolean }) => void;
  closeTaskDialog: () => void;
}

export const useUI = create<UIState>((set) => ({
  view: "today",
  paletteOpen: false,
  taskDialog: { open: false, taskId: null },
  setView: (view) => set({ view }),
  openPalette: (open = true) => set({ paletteOpen: open }),
  openTaskDialog: (taskId, opts) =>
    set({ taskDialog: { open: true, taskId, inboxOnly: opts?.inboxOnly } }),
  closeTaskDialog: () => set({ taskDialog: { open: false, taskId: null } }),
}));
