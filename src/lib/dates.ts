// Date helpers (date-fns based, design doc §2.3).

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
