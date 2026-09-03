/** SOP/EOP w formacie miesiąc.rok (np. 2.2021, 12.2030) — rok zawsze 4 cyfry. */

export type SopEopParts = { month: number; year: number };

function yearFromFraction(fraction: number): number | null {
  const year = Math.round(fraction * 10000 + 1e-4);
  if (year < 1900 || year > 2200) return null;
  return year;
}

function parseFromNumeric(value: number): SopEopParts | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const month = Math.floor(value);
  if (month < 1 || month > 12) return null;
  const year = yearFromFraction(value - month);
  if (year == null) return null;
  return { month, year };
}

function expandYearDigits(yearStr: string): number | null {
  if (!/^\d+$/.test(yearStr)) return null;
  if (yearStr.length === 4) {
    const y = parseInt(yearStr, 10);
    return y >= 1900 && y <= 2200 ? y : null;
  }
  if (yearStr.length === 3) {
    const y = parseInt(`${yearStr}0`, 10);
    return y >= 1900 && y <= 2200 ? y : null;
  }
  if (yearStr.length === 2) {
    const y = 2000 + parseInt(yearStr, 10);
    return y >= 1900 && y <= 2200 ? y : null;
  }
  return null;
}

/** Parsuje SOP/EOP; naprawia skrócone lata po imporcie z Excela (np. 5.203 → 5.2030). */
export function parseSopEop(value: unknown): SopEopParts | null {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return parseFromNumeric(value);
  }

  const s = String(value).trim();
  if (!s) return null;

  const dash = s.match(/^(\d{4})-(\d{1,2})$/);
  if (dash) {
    const year = parseInt(dash[1], 10);
    const month = parseInt(dash[2], 10);
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2200) return { month, year };
  }

  const dot = s.match(/^(\d{1,2})\.(\d+)$/);
  if (dot) {
    const month = parseInt(dot[1], 10);
    if (month >= 1 && month <= 12) {
      const year = expandYearDigits(dot[2]);
      if (year != null) return { month, year };
    }
  }

  if (/^\d+\.\d+$/.test(s)) {
    const fromNum = parseFromNumeric(Number(s));
    if (fromNum) return fromNum;
  }

  return null;
}

/** Format do wyświetlania i zapisu: miesiąc.rok z 4-cyfrowym rokiem. */
export function formatSopEop(value: unknown): string {
  const parsed = parseSopEop(value);
  if (!parsed) return String(value ?? '').trim();
  return `${parsed.month}.${parsed.year}`;
}

export function sopEopYearsRange(sop: unknown, eop: unknown): { years: number[]; startMonth?: number; endMonth?: number } {
  const sopP = parseSopEop(sop);
  const eopP = parseSopEop(eop);
  if (!sopP || !eopP || eopP.year < sopP.year) return { years: [] };
  const years: number[] = [];
  for (let y = sopP.year; y <= eopP.year; y++) years.push(y);
  return { years, startMonth: sopP.month, endMonth: eopP.month };
}

/** Liczba miesięcy produkcji w danym roku kalendarzowym (wg SOP/EOP). */
export function getProductionMonthsInYear(sop: unknown, eop: unknown, year: number): number {
  const sopP = parseSopEop(sop);
  const eopP = parseSopEop(eop);
  if (!sopP || !eopP || year < sopP.year || year > eopP.year) return 0;
  if (year === sopP.year && year === eopP.year) return Math.max(0, eopP.month - sopP.month + 1);
  if (year === sopP.year) return 13 - sopP.month;
  if (year === eopP.year) return eopP.month;
  return 12;
}

/** Czy dany miesiąc kalendarzowy mieści się w okresie SOP–EOP (brak dat = cały rok). */
export function isMonthInProduction(sop: unknown, eop: unknown, year: number, month: number): boolean {
  if (month < 1 || month > 12) return false;
  const sopP = parseSopEop(sop);
  const eopP = parseSopEop(eop);
  if (!sopP || !eopP) return true;
  if (year < sopP.year || year > eopP.year) return false;
  if (year === sopP.year && month < sopP.month) return false;
  if (year === eopP.year && month > eopP.month) return false;
  return true;
}

/** Numery miesięcy (1–12) aktywnych w danym roku wg SOP/EOP. */
export function getProductionMonthNumbersInYear(sop: unknown, eop: unknown, year: number): number[] {
  const months: number[] = [];
  for (let m = 1; m <= 12; m++) {
    if (isMonthInProduction(sop, eop, year, m)) months.push(m);
  }
  return months;
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

/** Poniedziałki kalendarzowe wypadające w danym miesiącu (kolejność rosnąca). */
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

/**
 * Tydzień pn–nd przypisujemy do miesiąca, w którym się zaczyna (poniedziałek).
 * Całomy miesięcy nie dublują tego samego CW w dwóch miesiącach.
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

/**
 * Liczba tygodni w miesiącu = liczba poniedziałków w tym miesiącu
 * (tydzień na przełomie należy tylko do miesiąca startu).
 */
export function getWeekCountInMonth(year: number, month: number): number {
  return Math.max(1, mondaysFallingInMonth(year, month).length);
}

/**
 * Numer tygodnia w miesiącu startu tygodnia (1 = pierwszy poniedziałek miesiąca).
 * Dla dat z „ogona” tygodnia zaczynającego się w poprzednim miesiącu zwraca indeks w miesiącu startu
 * — preferuj {@link assignIsoWeekToStartMonth}, gdy potrzebujesz też poprawnego miesiąca/roku.
 */
export function weekOfMonthFromDate(year: number, month: number, day: number): number {
  return assignIsoWeekToStartMonth(year, month, day).week;
}
