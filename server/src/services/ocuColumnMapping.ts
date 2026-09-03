/**
 * Mapowanie liter kolumn arkusza Input (Katowice_Data) dla eksportu OCU.
 * Litera = Excel (A, B, …, AA, AB…).
 */

export type OcuColumnLetters = {
  /** Date Year — odczyt */
  year: string;
  /** Sonar Part Code — odczyt */
  sonarCode: string;
  /** Linia L… — zapis */
  x: string;
  /** ERP — zapis */
  ab: string;
  /** Gniazda 1+1… — zapis */
  ac: string;
  /** 3600/cykl — zapis */
  ad: string;
  /** Liczba gniazd — zapis */
  ae: string;
  /** S1619 ERP No */
  s1619Erp: string;
  /** S1619 Machinegroup (czyszczenie) */
  s1619MachineGroup: string;
  /** S2102 większa — początek bloku (Machinegroup) … koniec (Width) */
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
  /** S2102 mniejsza */
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

/** Domyślne litery (szablon sprzed dodania kolumny po S). */
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

/** Klucze mapowania z etykietami (nagłówki / role) — UI. */
export const OCU_COLUMN_FIELD_META: {
  key: keyof OcuColumnLetters;
  /** Typowa nazwa w nagłówku Input */
  headerHint: string;
  role: 'read' | 'write_capacity' | 'write_routing';
}[] = [
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

/**
 * Przesuwa o `shift` wszystkie kolumny o literze ściśle po `afterLetter` (np. po S → +1 przy nowej kolumnie T).
 * Kolumna `afterLetter` (np. Sonar = S) bez zmian.
 */
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

export function mergeOcuColumnLetters(partial?: Partial<OcuColumnLetters> | null): OcuColumnLetters {
  const base = { ...DEFAULT_OCU_COLUMN_LETTERS };
  if (!partial || typeof partial !== 'object') return base;
  for (const key of Object.keys(base) as (keyof OcuColumnLetters)[]) {
    const norm = normalizeExcelLetter(String(partial[key] ?? ''));
    if (norm) base[key] = norm;
  }
  return base;
}

/** Dopasuj litery do nagłówków Input (gdy da się rozpoznać po nazwie). */
export function applyHeaderHintsToColumnLetters(
  headers: { letter: string; header: string }[],
  base: OcuColumnLetters = DEFAULT_OCU_COLUMN_LETTERS
): OcuColumnLetters {
  const next = { ...base };
  const byLower = headers.map((h) => ({
    letter: h.letter,
    header: h.header,
    low: h.header.trim().toLowerCase(),
  }));

  const find = (...preds: ((low: string) => boolean)[]): string | null => {
    for (const p of preds) {
      const hit = byLower.find((h) => h.low && p(h.low));
      if (hit) return hit.letter;
    }
    return null;
  };

  const sonar = find((h) => h.includes('sonar part code'));
  if (sonar) next.sonarCode = sonar;
  const year = find((h) => h.includes('date year') || h === 'year');
  if (year) next.year = year;

  // Capacity Opt1cxx — kolejność w szablonie: Line / ERP / nests / UPH / cavities (przybliżenie po nazwach)
  const x = find(
    (h) => h.includes('opt1cxx') && (h.includes('line') || h.includes('location') || h.includes('machine')),
    (h) => h.includes('opt1c') && h.includes('line')
  );
  if (x) next.x = x;

  const ab = find(
    (h) => h.includes('opt1cxx') && (h.includes('erp') || h.includes('sap')),
    (h) => h.includes('opt1c') && h.includes('erp')
  );
  if (ab) next.ab = ab;

  const ac = find(
    (h) => h.includes('opt1cxx') && (h.includes('nest') || h.includes('cavit') || h.includes('1+1')),
    (h) => h.includes('opt1c') && h.includes('nest')
  );
  if (ac) next.ac = ac;

  const ad = find(
    (h) => h.includes('opt1cxx') && (h.includes('3600') || h.includes('uph') || h.includes('unit')),
    (h) => h.includes('opt1c') && (h.includes('cycle') || h.includes('uph'))
  );
  if (ad) next.ad = ad;

  const ae = find(
    (h) => h.includes('opt1cxx') && (h.includes('count') || h.includes('qty') || h.includes('number of nest')),
    (h) => h.includes('opt1c') && h.includes('gniazd')
  );
  if (ae) next.ae = ae;

  return next;
}
