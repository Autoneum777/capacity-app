export type PeriodMonthData = {
  load_percent: number;
  call_off_load_percent?: number;
  weeks: Record<
    number,
    {
      load_percent: number;
      call_off_load_percent?: number;
      detail_breakdown?: DetailBreakdownEntry[];
      call_off_detail_breakdown?: DetailBreakdownEntry[];
      material_breakdown?: MaterialBreakdownEntry[];
      call_off_material_breakdown?: MaterialBreakdownEntry[];
    }
  >;
  has_sop?: boolean;
  has_eop?: boolean;
  detail_breakdown?: DetailBreakdownEntry[];
  call_off_detail_breakdown?: DetailBreakdownEntry[];
  material_breakdown?: MaterialBreakdownEntry[];
  call_off_material_breakdown?: MaterialBreakdownEntry[];
};

export type DetailBreakdownEntry = {
  project_label?: string;
  detail_label: string;
  contribution_percent: number;
  share_percent?: number;
  volume_quantity?: number;
  has_rfq?: boolean;
};

export type MaterialBreakdownEntry = {
  material_alias: string | null;
  material_sap: string | null;
  material_width_mm?: number | null;
  material_length_mm?: number | null;
  material_grammage_kg_m2?: number | null;
  contribution_percent: number;
  details: { project_label: string; detail_label: string; contribution_percent: number }[];
};

export type PeriodBreakdownMachine = {
  machine_id: number;
  has_sop?: boolean;
  has_eop?: boolean;
  months: Record<number, PeriodMonthData>;
};

export type YearSopEopMarkers = {
  has_sop: boolean;
  has_eop: boolean;
  months: Record<number, { has_sop: boolean; has_eop: boolean }>;
};

export type MachineSopEopMarkers = {
  machine_id: number;
  years: Record<number, YearSopEopMarkers>;
};

export type TimelineColumn =
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'week'; year: number; month: number; week: number };

export type VerticalExpansionRow =
  | { kind: 'month'; month: number; indent: 1 }
  | { kind: 'week'; month: number; week: number; indent: 2 };

export function periodMonthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

export function periodMachineMonthKey(machineId: number, month: number): string {
  return `${machineId}-${month}`;
}

export function getWeekCountInMonth(year: number, month: number): number {
  return Math.max(1, mondaysFallingInMonth(year, month).length);
}

/** Poniedziałki kalendarzowe wypadające w danym miesiącu. */
export function mondaysFallingInMonth(year: number, month: number): Date[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  if (daysInMonth < 1) return [];
  const out: Date[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    if (d.getDay() !== 1) continue;
    d.setHours(0, 0, 0, 0);
    out.push(d);
  }
  return out;
}

/** Poniedziałek tygodnia ISO (pn–nd) zawierającego podaną datę (czas lokalny). */
export function mondayOfIsoWeek(year: number, month: number, day: number): Date {
  const d = new Date(year, month - 1, day);
  const dow = d.getDay(); // 0=nd … 6=sb
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Tydzień pn–nd → miesiąc startu (poniedziałek) + numer tygodnia w tym miesiącu.
 * Przełom miesięcy: jeden CW tylko w miesiącu rozpoczęcia.
 */
export function assignIsoWeekToStartMonth(
  year: number,
  month: number,
  day: number
): { year: number; month: number; week: number } {
  const mon = mondayOfIsoWeek(year, month, day);
  const y = mon.getFullYear();
  const m = mon.getMonth() + 1;
  const mondays = mondaysFallingInMonth(y, m);
  const t = mon.getTime();
  let week = 1;
  for (let i = 0; i < mondays.length; i++) {
    if (mondays[i].getTime() === t) {
      week = i + 1;
      break;
    }
  }
  return { year: y, month: m, week };
}

/** Numer tygodnia w miesiącu startu tygodnia (1 = pierwszy poniedziałek miesiąca). */
export function weekOfMonthFromDate(year: number, month: number, day: number): number {
  return assignIsoWeekToStartMonth(year, month, day).week;
}

export function buildHorizontalTimelineColumns(
  years: number[],
  expandedYears: Set<number>,
  expandedMonths: Set<string>
): TimelineColumn[] {
  const cols: TimelineColumn[] = [];
  for (const year of years) {
    cols.push({ kind: 'year', year });
    if (!expandedYears.has(year)) continue;
    for (let month = 1; month <= 12; month++) {
      cols.push({ kind: 'month', year, month });
      if (!expandedMonths.has(periodMonthKey(year, month))) continue;
      const weekCount = getWeekCountInMonth(year, month);
      for (let week = 1; week <= weekCount; week++) {
        cols.push({ kind: 'week', year, month, week });
      }
    }
  }
  return cols;
}

/** Pionowe rozwinięcie: wiersze miesięcy/tygodni z wartościami we wszystkich latach obok siebie. */
export function getVerticalExpansionRows(
  machineId: number,
  expandedMachines: Set<number>,
  expandedMachineMonths: Set<string>,
  years: number[]
): VerticalExpansionRow[] {
  if (!expandedMachines.has(machineId)) return [];
  const rows: VerticalExpansionRow[] = [];
  for (let month = 1; month <= 12; month++) {
    rows.push({ kind: 'month', month, indent: 1 });
    const monthKey = periodMachineMonthKey(machineId, month);
    if (!expandedMachineMonths.has(monthKey)) continue;
    const maxWeeks =
      years.length > 0 ? Math.max(...years.map((year) => getWeekCountInMonth(year, month))) : getWeekCountInMonth(2020, month);
    for (let week = 1; week <= maxWeeks; week++) {
      rows.push({ kind: 'week', month, week, indent: 2 });
    }
  }
  return rows;
}

export function getTimelineColumnLoad(
  col: TimelineColumn,
  yearlyLoad: number | undefined,
  monthsData: Record<number, PeriodMonthData> | undefined
): number {
  if (col.kind === 'year') return yearlyLoad ?? 0;
  if (!monthsData) return 0;
  if (col.kind === 'month') return monthsData[col.month]?.load_percent ?? 0;
  return monthsData[col.month]?.weeks[col.week]?.load_percent ?? 0;
}

export function getTimelineColumnCallOffLoad(
  col: TimelineColumn,
  yearlyCallOffLoad: number | undefined,
  monthsData: Record<number, PeriodMonthData> | undefined
): number {
  if (col.kind === 'year') return yearlyCallOffLoad ?? 0;
  if (!monthsData) return 0;
  if (col.kind === 'month') return monthsData[col.month]?.call_off_load_percent ?? 0;
  return monthsData[col.month]?.weeks[col.week]?.call_off_load_percent ?? 0;
}

export function getVerticalCellLoad(
  _year: number,
  row: VerticalExpansionRow,
  monthsData: Record<number, PeriodMonthData> | undefined
): number {
  if (!monthsData) return 0;
  if (row.kind === 'month') return monthsData[row.month]?.load_percent ?? 0;
  return monthsData[row.month]?.weeks[row.week]?.load_percent ?? 0;
}

export function getVerticalCellCallOffLoad(
  _year: number,
  row: VerticalExpansionRow,
  monthsData: Record<number, PeriodMonthData> | undefined
): number {
  if (!monthsData) return 0;
  if (row.kind === 'month') return monthsData[row.month]?.call_off_load_percent ?? 0;
  return monthsData[row.month]?.weeks[row.week]?.call_off_load_percent ?? 0;
}

export function getYearMarkers(
  markerIndex: Map<number, Record<number, YearSopEopMarkers>> | undefined,
  machineId: number,
  year: number
): YearSopEopMarkers | undefined {
  return markerIndex?.get(machineId)?.[year];
}

export function getMonthMarkers(
  markers: YearSopEopMarkers | undefined,
  month: number
): { has_sop: boolean; has_eop: boolean } {
  return markers?.months?.[month] ?? { has_sop: false, has_eop: false };
}

export function monthAbbrev(month: number, locale: string): string {
  try {
    const d = new Date(2020, month - 1, 1);
    return new Intl.DateTimeFormat(locale, { month: 'short' }).format(d);
  } catch {
    const fallback = ['', 'Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru'];
    return fallback[month] ?? String(month);
  }
}

/** Numer tygodnia ISO (1–53) — jak w kalendarzu / SAP CW (tydzień pn–nd). */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Tydzień kalendarzowy (ISO / CW) dla T1…Tn w miesiącu.
 * T1 = pierwszy poniedziałek miesiąca (tydzień na przełomie → miesiąc startu).
 */
export function calendarWeekForMonthWeek(year: number, month: number, weekOfMonth: number): number {
  const mondays = mondaysFallingInMonth(year, month);
  if (!mondays.length) {
    const monday = mondayOfIsoWeek(year, month, 1);
    const thursday = new Date(monday);
    thursday.setDate(monday.getDate() + 3);
    return isoWeekNumber(thursday);
  }
  const w = Math.max(1, Math.floor(Number(weekOfMonth)) || 1);
  const monday = mondays[Math.min(w, mondays.length) - 1]!;
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  return isoWeekNumber(thursday);
}
