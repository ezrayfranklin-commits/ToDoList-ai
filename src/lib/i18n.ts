// Lightweight i18n: Zustand store + t() with {var} interpolation.
// No external dep. Persists ui.lang via settings store (SQLite).

import { create } from "zustand";
import { zh } from "@/locales/zh";
import { en } from "@/locales/en";

export type AppLang = "zh" | "en";

const dicts = { zh, en } as const;

interface I18nState {
  lang: AppLang;
  setLang: (lang: AppLang) => void;
  initLang: (lang: AppLang) => void;
}

export const useI18n = create<I18nState>((set) => ({
  lang: "zh",
  setLang: (lang) => set({ lang }),
  initLang: (lang) => set({ lang }),
}));

type Key = keyof typeof zh;

/** Translate a key; unknown keys fall back to the key itself. */
export function t(key: Key, vars?: Record<string, string | number | null | undefined>): string {
  const { lang } = useI18n.getState();
  let s: string = dicts[lang][key] ?? zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (v === null || v === undefined) continue;
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** date-fns locale for the current UI language. */
export function dateLocale() {
  // Dynamic import-style map; zhCN/enUS come from date-fns/locale.
  // Imported statically to keep tree-shaking simple.
  return lang() === "zh" ? zhLocale : enLocale;
}

// Hoist date-fns locales here so consumers import them once.
import { zhCN as zhLocale, enUS as enLocale } from "date-fns/locale";

export function lang(): AppLang {
  return useI18n.getState().lang;
}

export const isZh = () => lang() === "zh";
