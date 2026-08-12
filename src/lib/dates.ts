// Date helpers (date-fns based, design doc).

import {
  addDays,
  format,
  isSameDay,
  parseISO,
  startOfDay,
} from "date-fns";
import { zhCN } from "date-fns/locale";

export const todayStr = (): string => format(new Date(), "yyyy-MM-dd");

export const toDateStr = (d: Date): string => format(d, "yyyy-MM-dd");

export const displayDate = (d: Date | string): string => {
  const date = typeof d === "string" ? parseISO(d) : d;
  return format(date, "M月d日 EEEE", { locale: zhCN });
};

export const isToday = (dateStr: string): boolean =>
  isSameDay(parseISO(dateStr), new Date());

export const tomorrowStr = (): string => toDateStr(addDays(startOfDay(new Date()), 1));

export const weekdayCN = (d: Date): string =>
  format(d, "EEEE", { locale: zhCN });

/** Current time as HH:mm */
export const nowHHmm = (): string => format(new Date(), "HH:mm");

/**
 * Parse SQLite datetime strings ("YYYY-MM-DD HH:MM:SS", UTC) safely.
 * WKWebView/Safari rejects the space+Z form (returns Invalid Date), while
 * V8 accepts it — so normalize to ISO 8601 before parsing. Never throws.
 */
export function parseDbTime(t: string | null | undefined): Date {
  if (!t) return new Date(NaN);
  const iso = t.includes("T") ? t : t.replace(" ", "T");
  return new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
}

/** Format a DB datetime; returns "" for invalid input (never throws). */
export function formatDbTime(t: string | null | undefined, fmt = "HH:mm"): string {
  const d = parseDbTime(t);
  return Number.isNaN(d.getTime()) ? "" : format(d, fmt);
}
