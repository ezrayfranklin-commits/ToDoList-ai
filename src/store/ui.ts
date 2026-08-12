// UI state (Zustand, design doc §2.2).

import { create } from "zustand";

export type View = "today" | "inbox" | "review" | "settings";

interface UIState {
  view: View;
  paletteOpen: boolean;
  taskDialog: { open: boolean; taskId: number | null; inboxOnly?: boolean };
  /** 当前 AI 对话会话 id（ChatGPT 式会话历史，null = 未选择） */
  currentConversationId: number | null;
  setView: (v: View) => void;
  openPalette: (open?: boolean) => void;
  openTaskDialog: (taskId: number | null, opts?: { inboxOnly?: boolean }) => void;
  closeTaskDialog: () => void;
  setCurrentConversation: (id: number | null) => void;
}

export const useUI = create<UIState>((set) => ({
  view: "today",
  paletteOpen: false,
  taskDialog: { open: false, taskId: null },
  currentConversationId: null,
  setView: (view) => set({ view }),
  openPalette: (open = true) => set({ paletteOpen: open }),
  openTaskDialog: (taskId, opts) =>
    set({ taskDialog: { open: true, taskId, inboxOnly: opts?.inboxOnly } }),
  closeTaskDialog: () => set({ taskDialog: { open: false, taskId: null } }),
  setCurrentConversation: (id) => set({ currentConversationId: id }),
}));
