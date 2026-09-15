import { db } from '../db/connection.js';
import { blankMassKg, resolveBaselineMaterialAlias } from '../utils/baselineMaterialMass.js';

export type BaselineMachineConfig = {
  machine_id: number;
  is_baseline?: number | boolean | null;
  baseline_available_hours_per_week?: number | null;
  baseline_weeks_per_year?: number | null;
  baseline_max_throughput_kg_h?: number | null;
  baseline_max_throughput_unit?: string | null;
  baseline_max_speed_m_min?: number | null;
  baseline_max_speed_unit?: string | null;
  baseline_max_blank_width_mm?: number | null;
  baseline_max_blank_width_unit?: string | null;
  baseline_min_length_mm?: number | null;
  baseline_max_blanks_across?: number | null;
  oee_override?: number | null;
};

export type BaselineMaterial = {
  material_id: number;
  machine_id: number;
  designation_id: number;
  alias: string | null;
  sap_number: string | null;
  description: string | null;
  grammage_kg_m2: number | null;
  width_mm: number | null;
  length_mm: number | null;
  consumption_per_detail: number | null;
  production_share_percent: number | null;
};

export type BaselineMaterialIndex = Map<string, BaselineMaterial[]>;

/** Indeks materiałów z wolumenem zewnętrznym: material_id → wolumen tygodniowy per rok */
export type BaselineExternalVolumeIndex = Map<number, Map<number, number>>;

export function loadBaselineExternalVolumeIndex(): BaselineExternalVolumeIndex {
  const rows = db
    .prepare(
      `SELECT v.material_id, v.year, v.weekly_volume,
              bm.machine_id, bm.grammage_kg_m2, bm.width_mm, bm.length_mm,
              bm.production_share_percent
       FROM machine_baseline_material_volumes v
       JOIN machine_baseline_materials bm ON bm.id = v.material_id
       WHERE bm.use_external_volume = 1 AND bm.include_in_capacity = 1`
    )
    .all() as { material_id: number; year: number; weekly_volume: number }[];
  const index: BaselineExternalVolumeIndex = new Map();
  for (const r of rows) {
    const mid = Number(r.material_id);
    if (!index.has(mid)) index.set(mid, new Map());
    index.get(mid)!.set(Number(r.year), Number(r.weekly_volume));
  }
  return index;
}

/** Lista materiałów z wolumenem zewnętrznym per maszyna (dla budowania syntetycznych operacji) */
export type BaselineExternalMaterial = BaselineMaterial & {
  material_id: number;
  use_external_volume: number;
};

export type BaselineExternalMaterialIndex = Map<number, BaselineExternalMaterial[]>;

export function loadBaselineExternalMaterialIndex(): BaselineExternalMaterialIndex {
  const rows = db
    .prepare(
      `SELECT bm.id AS material_id, bm.machine_id,
              bm.alias, bm.sap_number, bm.description,
              bm.grammage_kg_m2, bm.width_mm, bm.length_mm,
              bm.production_share_percent, bm.use_external_volume,
              1 AS designation_id, 1 AS consumption_per_detail
       FROM machine_baseline_materials bm
       WHERE bm.use_external_volume = 1 AND bm.include_in_capacity = 1`
    )
    .all() as BaselineExternalMaterial[];
  const index: BaselineExternalMaterialIndex = new Map();
  for (const r of rows) {
    const mid = Number(r.machine_id);
    if (!index.has(mid)) index.set(mid, []);
    index.get(mid)!.push(r);
  }
  return index;
}

export function orientBaselineDimensions(
  machine: BaselineMachineConfig,
  dimensionA: number,
  dimensionB: number
): { widthMm: number; lengthMm: number } {
  const maxWidthRaw = positive(machine.baseline_max_blank_width_mm) ?? 1400;
  const maxWidth =
    String(machine.baseline_max_blank_width_unit ?? 'mm').toLowerCase() === 'cm'
      ? maxWidthRaw * 10
      : maxWidthRaw;
  const minLength = positive(machine.baseline_min_length_mm) ?? 650;
  // Oba boki większe niż limit szerokości (np. > 1400 mm) — żadna orientacja nie
  // zmieści się w torze, więc szerokością bierzemy niższą z dwóch wartości (mniej „nielegalna”).
  if (dimensionA > maxWidth && dimensionB > maxWidth) {
    return dimensionA <= dimensionB
      ? { widthMm: dimensionA, lengthMm: dimensionB }
      : { widthMm: dimensionB, lengthMm: dimensionA };
  }
  const candidates = [
    { widthMm: dimensionA, lengthMm: dimensionB },
    { widthMm: dimensionB, lengthMm: dimensionA },
  ].filter((d) => d.widthMm <= maxWidth && d.lengthMm >= minLength);
  if (candidates.length > 0) {
    return candidates.sort((a, b) => b.widthMm - a.widthMm)[0];
  }
  return dimensionA <= maxWidth
    ? { widthMm: dimensionA, lengthMm: dimensionB }
    : { widthMm: dimensionB, lengthMm: dimensionA };
}

/**
 * Linia wyciska jedną wstęgę o szerokości = liczba torów × szerokość formatki.
 * Limit masowy wynika z przepływu masy całej wstęgi, limit prędkościowy z jej
 * długości; oba podawane są w formatkach na godzinę.
 */
export type BaselineMaterialHourlyCapacity = {
  massKg: number;
  blanksAcross: number;
  /** Szerokość wyciskanej wstęgi [mm]. */
  webWidthMm: number;
  /** Masa wstęgi o długości formatki [kg]. */
  webMassKg: number;
  /** Limit z maksymalnego przepływu masy [formatki/h]. */
  massCapacityPerHour: number | null;
  /** Limit z maksymalnej prędkości [formatki/h]. */
  speedCapacityPerHour: number | null;
  /** Rzeczywista wydajność = mniejszy z limitów [formatki/h]. */
  actualCapacityPerHour: number;
};

function key(machineId: number, designationId: number): string {
  return `${machineId}|${designationId}`;
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function loadBaselineMaterialIndex(): BaselineMaterialIndex {
  const rows = db
    .prepare(
      `SELECT bm.id AS material_id, bm.machine_id, bmp.designation_id,
              bm.alias, bm.sap_number, bm.description,
              bm.grammage_kg_m2, bm.width_mm, bm.length_mm,
              bmp.consumption_per_detail, bm.production_share_percent
       FROM machine_baseline_material_parts bmp
       JOIN machine_baseline_materials bm ON bm.id = bmp.material_id
       WHERE bm.include_in_capacity = 1`
    )
    .all() as BaselineMaterial[];
  const index: BaselineMaterialIndex = new Map();
  for (const row of rows) {
    const k = key(Number(row.machine_id), Number(row.designation_id));
    const list = index.get(k);
    if (list) list.push(row);
    else index.set(k, [row]);
  }
  return index;
}

/**
 * Liczba formatek produkowanych równolegle na szerokości linii; ogranicza ją
 * liczba noży, dlatego wynik nie przekracza baseline_max_blanks_across.
 * Np. szerokość linii 1400 mm, formatka 650 mm i limit 2 => 2 tory.
 */
export function baselineBlanksAcross(
  machine: BaselineMachineConfig,
  blankWidthMm: number
): number {
  const maxAcross = Math.max(1, Math.floor(positive(machine.baseline_max_blanks_across) ?? 1));
  const rawMaxWidth = positive(machine.baseline_max_blank_width_mm);
  const maxWidth =
    rawMaxWidth == null
      ? null
      : String(machine.baseline_max_blank_width_unit ?? 'mm').toLowerCase() === 'cm'
        ? rawMaxWidth * 10
        : rawMaxWidth;
  if (maxAcross <= 1 || maxWidth == null || blankWidthMm <= 0) return 1;
  return Math.max(1, Math.min(maxAcross, Math.floor(maxWidth / blankWidthMm)));
}

/**
 * Limit masowy (maks. kg/h / masa formatki), limit prędkościowy (długość wstęgi
 * na godzinę × liczba torów) i wynikowa, mniejsza z nich wydajność rzeczywista.
 */
export function baselineMaterialHourlyCapacity(
  machine: BaselineMachineConfig,
  material: Pick<BaselineMaterial, 'grammage_kg_m2' | 'width_mm' | 'length_mm'>
): BaselineMaterialHourlyCapacity | null {
  const grammage = positive(material.grammage_kg_m2);
  const dimensionA = positive(material.width_mm);
  const dimensionB = positive(material.length_mm);
  if (grammage == null || dimensionA == null || dimensionB == null) return null;
  const oriented = orientBaselineDimensions(machine, dimensionA, dimensionB);
  const width = oriented.widthMm;
  const length = oriented.lengthMm;
  const rawThroughput = positive(machine.baseline_max_throughput_kg_h);
  const throughputKgH =
    rawThroughput == null
      ? null
      : String(machine.baseline_max_throughput_unit ?? 'kg/h').toLowerCase() === 't/h'
        ? rawThroughput * 1000
        : rawThroughput;
  const rawSpeed = positive(machine.baseline_max_speed_m_min);
  const speedMMin =
    rawSpeed == null
      ? null
      : String(machine.baseline_max_speed_unit ?? 'm/min').toLowerCase() === 'm/s'
        ? rawSpeed * 60
        : rawSpeed;
  if (throughputKgH == null && speedMMin == null) return null;

  const massKg = blankMassKg(grammage, width, length);
  if (massKg == null || massKg <= 0) return null;

  const blanksAcross = baselineBlanksAcross(machine, width);
  const webWidthMm = width * blanksAcross;
  const webMassKg = massKg * blanksAcross;
  const massCapacityPerHour = throughputKgH == null ? null : throughputKgH / massKg;
  const speedCapacityPerHour =
    speedMMin == null ? null : ((speedMMin * 60) / (length / 1000)) * blanksAcross;
  const actualCapacityPerHour = Math.min(
    massCapacityPerHour ?? Number.POSITIVE_INFINITY,
    speedCapacityPerHour ?? Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(actualCapacityPerHour) || actualCapacityPerHour <= 0) return null;

  return {
    massKg,
    blanksAcross,
    webWidthMm,
    webMassKg,
    massCapacityPerHour,
    speedCapacityPerHour,
    actualCapacityPerHour,
  };
}

/**
 * Czas zajęcia linii = wolumen formatek / rzeczywista wydajność materiału.
 * Dla detalu z wieloma materiałami czasy produkcji materiałów sumują się.
 */
export function baselineRequiredSeconds(
  machine: BaselineMachineConfig,
  designationId: number | null | undefined,
  weeklyPieces: number,
  materials: BaselineMaterialIndex
): number {
  if (!Number(machine.is_baseline) || !Number.isFinite(weeklyPieces) || weeklyPieces <= 0) return 0;
  const designation = Number(designationId);
  if (!Number.isFinite(designation) || designation <= 0) return 0;

  let requiredHours = 0;
  for (const material of materials.get(key(Number(machine.machine_id), designation)) ?? []) {
    const hourlyCapacity = baselineMaterialHourlyCapacity(machine, material);
    if (hourlyCapacity == null) continue;
    const consumptionRaw = Number(material.consumption_per_detail);
    const consumption =
      Number.isFinite(consumptionRaw) && consumptionRaw >= 0 ? consumptionRaw : 1;
    const shareRaw = Number(material.production_share_percent);
    const productionShare =
      Number.isFinite(shareRaw) ? Math.min(100, Math.max(0, shareRaw)) / 100 : 1;
    const requiredBlanks = weeklyPieces * consumption * productionShare;
    requiredHours += requiredBlanks / hourlyCapacity.actualCapacityPerHour;
  }
  return requiredHours * 3600;
}

/**
 * Jak baselineRequiredSeconds, ale zwraca rozbicie per materiał (na potrzeby tooltip breakdown).
 */
export type BaselineMaterialBreakdownEntry = {
  material_id: number;
  alias: string | null;
  sap_number: string | null;
  width_mm: number | null;
  length_mm: number | null;
  grammage_kg_m2: number | null;
  requiredSeconds: number;
};

export function baselineRequiredSecondsPerMaterial(
  machine: BaselineMachineConfig,
  designationId: number | null | undefined,
  weeklyPieces: number,
  materials: BaselineMaterialIndex
): BaselineMaterialBreakdownEntry[] {
  if (!Number(machine.is_baseline) || !Number.isFinite(weeklyPieces) || weeklyPieces <= 0) return [];
  const designation = Number(designationId);
  if (!Number.isFinite(designation) || designation <= 0) return [];

  const result: BaselineMaterialBreakdownEntry[] = [];
  for (const material of materials.get(key(Number(machine.machine_id), designation)) ?? []) {
    const hourlyCapacity = baselineMaterialHourlyCapacity(machine, material);
    if (hourlyCapacity == null) continue;
    const consumptionRaw = Number(material.consumption_per_detail);
    const consumption = Number.isFinite(consumptionRaw) && consumptionRaw >= 0 ? consumptionRaw : 1;
    const shareRaw = Number(material.production_share_percent);
    const productionShare = Number.isFinite(shareRaw) ? Math.min(100, Math.max(0, shareRaw)) / 100 : 1;
    const requiredBlanks = weeklyPieces * consumption * productionShare;
    const requiredHours = requiredBlanks / hourlyCapacity.actualCapacityPerHour;
    const dimensionA = positive(material.width_mm);
    const dimensionB = positive(material.length_mm);
    const oriented =
      dimensionA != null && dimensionB != null ? orientBaselineDimensions(machine, dimensionA, dimensionB) : null;
    result.push({
      material_id: Number(material.material_id),
      alias: resolveBaselineMaterialAlias(material.alias, material.description),
      sap_number: material.sap_number ?? null,
      width_mm: oriented?.widthMm ?? material.width_mm ?? null,
      length_mm: oriented?.lengthMm ?? material.length_mm ?? null,
      grammage_kg_m2: material.grammage_kg_m2 ?? null,
      requiredSeconds: requiredHours * 3600,
    });
  }
  return result;
}

/**
 * Czas zajęcia linii przez materiały z wolumenem zewnętrznym dla danej maszyny i roku.
 * Każdy taki materiał ma przypisany własny tygodniowy wolumen w tabeli machine_baseline_material_volumes.
 */
export function baselineExternalVolumeRequiredSeconds(
  machine: BaselineMachineConfig,
  year: number,
  externalVolumes: BaselineExternalVolumeIndex,
  externalMaterials: BaselineExternalMaterialIndex
): number {
  const materials = externalMaterials.get(Number(machine.machine_id)) ?? [];
  let requiredHours = 0;
  for (const mat of materials) {
    const mid = Number(mat.material_id);
    const yearVolumes = externalVolumes.get(mid);
    if (!yearVolumes) continue;
    const weeklyVol = yearVolumes.get(year) ?? 0;
    if (weeklyVol <= 0) continue;
    const hourlyCapacity = baselineMaterialHourlyCapacity(machine, mat);
    if (hourlyCapacity == null) continue;
    const shareRaw = Number(mat.production_share_percent);
    const productionShare = Number.isFinite(shareRaw) ? Math.min(100, Math.max(0, shareRaw)) / 100 : 1;
    const requiredBlanks = weeklyVol * productionShare;
    requiredHours += requiredBlanks / hourlyCapacity.actualCapacityPerHour;
  }
  return requiredHours * 3600;
}

export function baselineAvailabilitySeconds(
  machine: BaselineMachineConfig,
  resolvedOee: number
): number {
  const hours = positive(machine.baseline_available_hours_per_week) ?? 120;
  const oee = Number.isFinite(resolvedOee) ? Math.max(0, resolvedOee) : 0;
  return hours * 3600 * oee;
}
