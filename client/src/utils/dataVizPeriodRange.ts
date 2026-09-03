import { calendarWeekForMonthWeek, getWeekCountInMonth, assignIsoWeekToStartMonth } from './calculatorPeriodExpansion';

export type DataVizRangeMode = 'year' | 'month' | 'week';

export type VizTimelinePeriod = {
  id: number;
  label: string;
  year: number;
  month?: number;
  week?: number;
};

export type YearMonth = { year: number; month: number };

export type WeekAnchor = { year: number; month: number; week: number };

export type WeekAnchorOption = { key: string; label: string; anchor: WeekAnchor };

/** Nazwa miesiąca w wybranym języku interfejsu. */
export function localizedMonthName(month: number, locale: string, style: 'long' | 'short' = 'long'): string {
  const m = Math.min(12, Math.max(1, Math.floor(month)));
  return new Date(2000, m - 1, 1).toLocaleDateString(locale, { month: style });
}

export function currentYearMonth(): YearMonth {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function addMonths(year: number, month: number, delta: number): YearMonth {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function compareYearMonth(a: YearMonth, b: YearMonth): number {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

export function defaultMonthRange(): { from: YearMonth; to: YearMonth } {
  const cur = currentYearMonth();
  const to = addMonths(cur.year, cur.month, 5);
  return { from: cur, to };
}

export function enumerateMonthsBetween(
  from: YearMonth,
  to: YearMonth,
  labelFor: (year: number, month: number) => string
): VizTimelinePeriod[] {
  let cur = from;
  const end = compareYearMonth(from, to) <= 0 ? to : from;
  const out: VizTimelinePeriod[] = [];
  let id = 1;
  for (let guard = 0; guard < 240; guard++) {
    out.push({
      id,
      label: labelFor(cur.year, cur.month),
      year: cur.year,
      month: cur.month,
    });
    id++;
    if (cur.year === end.year && cur.month === end.month) break;
    cur = addMonths(cur.year, cur.month, 1);
  }
  return out;
}

export function currentWeekAnchor(): WeekAnchor {
  const d = new Date();
  return assignIsoWeekToStartMonth(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function parseWeekAnchorKey(key: string): WeekAnchor | null {
  const m = /^(\d{4})-(\d{2})-(\d+)$/.exec(String(key).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const week = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(week) || week < 1) return null;
  const maxW = getWeekCountInMonth(year, month);
  if (week > maxW) return null;
  return { year, month, week };
}

export function toWeekAnchorKey(a: WeekAnchor): string {
  return `${a.year}-${String(a.month).padStart(2, '0')}-${a.week}`;
}

function nextWeekAnchor(a: WeekAnchor): WeekAnchor {
  const maxW = getWeekCountInMonth(a.year, a.month);
  if (a.week < maxW) return { ...a, week: a.week + 1 };
  const nm = addMonths(a.year, a.month, 1);
  return { year: nm.year, month: nm.month, week: 1 };
}

export function compareWeekAnchor(a: WeekAnchor, b: WeekAnchor): number {
  const c = compareYearMonth(a, b);
  if (c !== 0) return c;
  return a.week - b.week;
}

export function defaultWeekRange(): { from: WeekAnchor; to: WeekAnchor } {
  const from = currentWeekAnchor();
  let to = from;
  for (let i = 0; i < 5; i++) to = nextWeekAnchor(to);
  return { from, to };
}

export function formatWeekAnchorLabel(
  anchor: WeekAnchor,
  locale: string,
  t: (key: string, params: Record<string, string | number>) => string
): string {
  const month = localizedMonthName(anchor.month, locale, 'short');
  const week = calendarWeekForMonthWeek(anchor.year, anchor.month, anchor.week);
  return t('calculator.periodWeekLabel', { year: anchor.year, month, week });
}

export function formatWeekAnchorShortLabel(
  anchor: WeekAnchor,
  locale: string,
  t: (key: string, params: Record<string, string | number>) => string
): string {
  const month = localizedMonthName(anchor.month, locale, 'short');
  const week = calendarWeekForMonthWeek(anchor.year, anchor.month, anchor.week);
  return `${month} · ${t('calculator.periodWeekOnly', { week })}`;
}

/** Lista tygodni w danym roku kalendarzowym (do selectu po wyborze roku). */
export function buildWeekAnchorSelectOptionsForYear(
  year: number,
  locale: string,
  t: (key: string, params: Record<string, string | number>) => string
): WeekAnchorOption[] {
  const y = Math.min(2100, Math.max(2000, Math.floor(year)));
  const out: WeekAnchorOption[] = [];
  for (let month = 1; month <= 12; month++) {
    const maxW = getWeekCountInMonth(y, month);
    for (let week = 1; week <= maxW; week++) {
      const anchor: WeekAnchor = { year: y, month, week };
      out.push({
        key: toWeekAnchorKey(anchor),
        label: formatWeekAnchorLabel(anchor, locale, t),
        anchor,
      });
    }
  }
  return out;
}

/** @deprecated Użyj buildWeekAnchorSelectOptionsForYear — zachowane dla kompatybilności. */
export function buildWeekAnchorSelectOptions(
  locale: string,
  t: (key: string, params: Record<string, string | number>) => string
): WeekAnchorOption[] {
  const y = currentYearMonth().year;
  const years = [y - 1, y, y + 1, y + 2, y + 3];
  return years.flatMap((yr) => buildWeekAnchorSelectOptionsForYear(yr, locale, t));
}

export function enumerateWeeksBetween(
  from: WeekAnchor,
  to: WeekAnchor,
  labelFor: (anchor: WeekAnchor) => string
): VizTimelinePeriod[] {
  let cur = from;
  const end = compareWeekAnchor(from, to) <= 0 ? to : from;
  const out: VizTimelinePeriod[] = [];
  let id = 1;
  for (let guard = 0; guard < 520; guard++) {
    out.push({
      id,
      label: labelFor(cur),
      year: cur.year,
      month: cur.month,
      week: cur.week,
    });
    id++;
    if (cur.year === end.year && cur.month === end.month && cur.week === end.week) break;
    cur = nextWeekAnchor(cur);
  }
  return out;
}

export function uniqueYearsFromPeriods(periods: VizTimelinePeriod[]): number[] {
  return [...new Set(periods.map((p) => p.year))].sort((a, b) => a - b);
}
