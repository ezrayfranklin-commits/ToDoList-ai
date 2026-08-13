// Settings store: SQLite-backed cache (local-first, 规划 §2.5) with
// optimistic writes. UI reads/writes here; persistence happens in db.

import { create } from "zustand";
import { getAllSettings, setSetting } from "@/lib/db";
import type { AISettings } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

interface SettingsState extends AISettings {
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AISettings>) => Promise<void>;
  setAutoPlan: (v: boolean) => Promise<void>;
  setNotifications: (v: boolean) => Promise<void>;
  setCarryOver: (v: boolean) => Promise<void>;
  setLang: (v: "zh" | "en") => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  provider: "ollama",
  model: "qwen2.5:7b",
  apiKey: "",
  baseUrl: "http://localhost:11434/v1",
  autoPlan: true,
  notifications: true,
  carryOver: true,
  autoReview: true,
  lang: "zh",
  loaded: false,

  load: async () => {
    const all = await getAllSettings();
    set({
      provider: (all["ai.provider"] as SettingsState["provider"]) ?? "ollama",
      model: (all["ai.model"] as string) ?? "qwen2.5:7b",
      apiKey: (all["ai.apiKey"] as string) ?? "",
      baseUrl: (all["ai.baseUrl"] as string) ?? "http://localhost:11434/v1",
      autoPlan: (all["autoPlan"] as boolean) ?? true,
      notifications: (all["notifications"] as boolean) ?? true,
      carryOver: (all["carryOver"] as boolean) ?? true,
      autoReview: (all["autoReview"] as boolean) ?? true,
      lang: (all["ui.lang"] as "zh" | "en") ?? "zh",
      loaded: true,
    });
    useI18n.getState().initLang((all["ui.lang"] as "zh" | "en") ?? "zh");
  },

  update: async (patch) => {
    const next = { ...get(), ...patch };
    set(next);
    const kv: Array<[string, unknown]> = [
      ["ai.provider", next.provider],
      ["ai.model", next.model],
      ["ai.apiKey", next.apiKey],
      ["ai.baseUrl", next.baseUrl],
      ["autoPlan", next.autoPlan],
      ["notifications", next.notifications],
      ["carryOver", next.carryOver],
      ["autoReview", next.autoReview],
      ["ui.lang", next.lang],
    ];
    for (const [k, v] of kv) await setSetting(k, v);
  },

  setAutoPlan: async (v) => {
    set({ autoPlan: v });
    await setSetting("autoPlan", v);
  },
  setNotifications: async (v) => {
    set({ notifications: v });
    await setSetting("notifications", v);
  },
  setCarryOver: async (v) => {
    set({ carryOver: v });
    await setSetting("carryOver", v);
  },
  setLang: async (v) => {
    set({ lang: v });
    useI18n.getState().setLang(v);
    await setSetting("ui.lang", v);
  },
}));
