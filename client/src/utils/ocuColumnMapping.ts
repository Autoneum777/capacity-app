/** Mapowanie liter kolumn Input (Katowice_Data) — UI + FormData do API. */

export type OcuColumnLetters = {
  year: string;
  sonarCode: string;
  x: string;
  ab: string;
  ac: string;
  ad: string;
  ae: string;
  s1619Erp: string;
  s1619MachineGroup: string;
  s2102LargeMachineGroup: string;
  s2102LargeCostCenter: string;
  s2102LargeCapacity: string;
  s2102LargeOeeActual: string;
  s2102LargeOeeTarget: string;
  s2102LargeErpNo: string;
  s2102LargeCavities: string;
  s2102LargeUnitPerHour: string;
  s2102LargeLanes: string;
  s2102LargeMoulded: string;
  s2102LargeLength: string;
  s2102LargeWidth: string;
  s2102SmallMachineGroup: string;
  s2102SmallCostCenter: string;
  s2102SmallCapacity: string;
  s2102SmallOeeActual: string;
  s2102SmallOeeTarget: string;
  s2102SmallErpNo: string;
  s2102SmallCavities: string;
  s2102SmallUnitPerHour: string;
  s2102SmallLanes: string;
  s2102SmallMoulded: string;
  s2102SmallLength: string;
  s2102SmallWidth: string;
};

export const DEFAULT_OCU_COLUMN_LETTERS: OcuColumnLetters = {
  year: 'E',
  sonarCode: 'S',
  x: 'X',
  ab: 'AB',
  ac: 'AC',
  ad: 'AD',
  ae: 'AE',
  s1619Erp: 'AK',
  s1619MachineGroup: 'AF',
  s2102LargeMachineGroup: 'CR',
  s2102LargeCostCenter: 'CS',
  s2102LargeCapacity: 'CT',
  s2102LargeOeeActual: 'CU',
  s2102LargeOeeTarget: 'CV',
  s2102LargeErpNo: 'CW',
  s2102LargeCavities: 'CX',
  s2102LargeUnitPerHour: 'CY',
  s2102LargeLanes: 'CZ',
  s2102LargeMoulded: 'DA',
  s2102LargeLength: 'DB',
  s2102LargeWidth: 'DC',
  s2102SmallMachineGroup: 'DD',
  s2102SmallCostCenter: 'DE',
  s2102SmallCapacity: 'DF',
  s2102SmallOeeActual: 'DG',
  s2102SmallOeeTarget: 'DH',
  s2102SmallErpNo: 'DI',
  s2102SmallCavities: 'DJ',
  s2102SmallUnitPerHour: 'DK',
  s2102SmallLanes: 'DL',
  s2102SmallMoulded: 'DM',
  s2102SmallLength: 'DN',
  s2102SmallWidth: 'DO',
};

export type OcuColumnFieldMeta = {
  key: keyof OcuColumnLetters;
  /** Klucz i18n: admin.ocuCol_<key> — fallback = headerHint */
  headerHint: string;
  role: 'read' | 'write_capacity' | 'write_routing';
};

export const OCU_COLUMN_FIELD_META: OcuColumnFieldMeta[] = [
  { key: 'year', headerHint: 'Date Year', role: 'read' },
  { key: 'sonarCode', headerHint: 'Sonar Part Code', role: 'read' },
  { key: 'x', headerHint: 'Opt1cxx (linia L…)', role: 'write_capacity' },
  { key: 'ab', headerHint: 'Opt1cxx (ERP)', role: 'write_capacity' },
  { key: 'ac', headerHint: 'Opt1cxx (gniazda 1+1…)', role: 'write_capacity' },
  { key: 'ad', headerHint: 'Opt1cxx (3600/cykl)', role: 'write_capacity' },
  { key: 'ae', headerHint: 'Opt1cxx (liczba gniazd)', role: 'write_capacity' },
  { key: 's1619MachineGroup', headerHint: 'S1619 Machinegroup', role: 'write_routing' },
  { key: 's1619Erp', headerHint: 'S1619 ERP No', role: 'write_routing' },
  { key: 's2102LargeMachineGroup', headerHint: 'S2102 large Machinegroup', role: 'write_routing' },
  { key: 's2102LargeCostCenter', headerHint: 'S2102 large Cost Center', role: 'write_routing' },
  { key: 's2102LargeCapacity', headerHint: 'S2102 large Capacity', role: 'write_routing' },
  { key: 's2102LargeOeeActual', headerHint: 'S2102 large OEE Actual', role: 'write_routing' },
  { key: 's2102LargeOeeTarget', headerHint: 'S2102 large OEE Target', role: 'write_routing' },
  { key: 's2102LargeErpNo', headerHint: 'S2102 large ERP No', role: 'write_routing' },
  { key: 's2102LargeCavities', headerHint: 'S2102 large Cavities', role: 'write_routing' },
  { key: 's2102LargeUnitPerHour', headerHint: 'S2102 large Unit/Base Qty', role: 'write_routing' },
  { key: 's2102LargeLanes', headerHint: 'S2102 large Lanes', role: 'write_routing' },
  { key: 's2102LargeMoulded', headerHint: 'S2102 large Moulded', role: 'write_routing' },
  { key: 's2102LargeLength', headerHint: 'S2102 large Length', role: 'write_routing' },
  { key: 's2102LargeWidth', headerHint: 'S2102 large Width', role: 'write_routing' },
  { key: 's2102SmallMachineGroup', headerHint: 'S2102 small Machinegroup', role: 'write_routing' },
  { key: 's2102SmallCostCenter', headerHint: 'S2102 small Cost Center', role: 'write_routing' },
  { key: 's2102SmallCapacity', headerHint: 'S2102 small Capacity', role: 'write_routing' },
  { key: 's2102SmallOeeActual', headerHint: 'S2102 small OEE Actual', role: 'write_routing' },
  { key: 's2102SmallOeeTarget', headerHint: 'S2102 small OEE Target', role: 'write_routing' },
  { key: 's2102SmallErpNo', headerHint: 'S2102 small ERP No', role: 'write_routing' },
  { key: 's2102SmallCavities', headerHint: 'S2102 small Cavities', role: 'write_routing' },
  { key: 's2102SmallUnitPerHour', headerHint: 'S2102 small Unit/Base Qty', role: 'write_routing' },
  { key: 's2102SmallLanes', headerHint: 'S2102 small Lanes', role: 'write_routing' },
  { key: 's2102SmallMoulded', headerHint: 'S2102 small Moulded', role: 'write_routing' },
  { key: 's2102SmallLength', headerHint: 'S2102 small Length', role: 'write_routing' },
  { key: 's2102SmallWidth', headerHint: 'S2102 small Width', role: 'write_routing' },
];

export const OCU_COLUMN_STORAGE_KEY = 'capacity.ocuColumnLetters.v1';

export function excelColIndexFromLetter(letter: string): number {
  const s = String(letter ?? '')
    .trim()
    .toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) continue;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function excelLetterFromColIndex0(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function normalizeExcelLetter(raw: string): string | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!s || s.length > 3) return null;
  return s;
}

export function shiftOcuColumnsAfterLetter(
  mapping: OcuColumnLetters,
  afterLetter: string,
  shift = 1
): OcuColumnLetters {
  const afterIdx = excelColIndexFromLetter(afterLetter);
  if (afterIdx < 0 || !Number.isFinite(shift) || shift === 0) return { ...mapping };
  const next = { ...mapping };
  for (const key of Object.keys(next) as (keyof OcuColumnLetters)[]) {
    const idx = excelColIndexFromLetter(next[key]);
    if (idx > afterIdx) {
      next[key] = excelLetterFromColIndex0(idx + shift);
    }
  }
  return next;
}

export function loadOcuColumnLettersFromStorage(): OcuColumnLetters {
  try {
    const raw = localStorage.getItem(OCU_COLUMN_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OCU_COLUMN_LETTERS };
    const parsed = JSON.parse(raw) as Partial<OcuColumnLetters>;
    const next = { ...DEFAULT_OCU_COLUMN_LETTERS };
    for (const key of Object.keys(next) as (keyof OcuColumnLetters)[]) {
      const norm = normalizeExcelLetter(String(parsed[key] ?? ''));
      if (norm) next[key] = norm;
    }
    return next;
  } catch {
    return { ...DEFAULT_OCU_COLUMN_LETTERS };
  }
}

export function saveOcuColumnLettersToStorage(mapping: OcuColumnLetters): void {
  try {
    localStorage.setItem(OCU_COLUMN_STORAGE_KEY, JSON.stringify(mapping));
  } catch {
    /* ignore quota */
  }
}
