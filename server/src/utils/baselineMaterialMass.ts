export function blankMassKg(grammageKgM2: number, widthMm: number, lengthMm: number): number | null {
  if (![grammageKgM2, widthMm, lengthMm].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return Math.round(grammageKgM2 * (widthMm / 1000) * (lengthMm / 1000) * 10000) / 10000;
}

/**
 * Kod komponentu BOM używany do filtrowania materiałów przy imporcie z pliku routing (np. „S2102”).
 * To NIE jest alias materiału — jeśli zostanie zapisany jako alias (stare/błędne dane), trzeba go
 * odtworzyć z opisu (patrz `resolveBaselineMaterialAlias`).
 */
export const BASELINE_ROUTING_MATERIAL_CODE = 'S2102';

/** Wyciąga alias materiału (np. „V377”, „A311”) z opisu komponentu BOM. */
export function materialAliasFromDescription(description: string | null | undefined): string | null {
  const excluded = new Set(['HIGH', 'LOW', 'INNER', 'OUTER', 'DASH', 'RH', 'LH']);
  const tokens =
    String(description ?? '')
      .toUpperCase()
      .match(/\b[A-Z0-9]{3,10}\b/g) ?? [];
  const aliases = tokens.filter((token) => /[A-Z]/.test(token) && /\d/.test(token) && !excluded.has(token));
  return aliases.at(-1) ?? null;
}

/**
 * Zwraca alias materiału do wyświetlenia. Jeśli zapisany alias jest pusty albo literalnie równy kodowi
 * BOM (np. „S2102” — stare dane z importu przed wprowadzeniem ekstrakcji aliasu), odtwarza go z opisu.
 */
export function resolveBaselineMaterialAlias(
  alias: string | null | undefined,
  description: string | null | undefined
): string | null {
  const trimmed = String(alias ?? '').trim();
  if (!trimmed || trimmed.toUpperCase() === BASELINE_ROUTING_MATERIAL_CODE) {
    return materialAliasFromDescription(description);
  }
  return trimmed;
}

/** Czytelna etykieta materiału do tooltipów: „Alias (SZERxDŁ mm, gramatura kg/m²)”. */
export function formatBaselineMaterialLabel(material: {
  alias?: string | null;
  sap_number?: string | null;
  description?: string | null;
  width_mm?: number | null;
  length_mm?: number | null;
  grammage_kg_m2?: number | null;
}): string {
  const resolvedAlias = resolveBaselineMaterialAlias(material.alias, material.description);
  const alias = resolvedAlias ?? material.sap_number ?? 'Materiał';
  const parts: string[] = [];
  const w = Number(material.width_mm);
  const l = Number(material.length_mm);
  if (Number.isFinite(w) && w > 0 && Number.isFinite(l) && l > 0) {
    parts.push(`${Math.round(w)}×${Math.round(l)} mm`);
  }
  const g = Number(material.grammage_kg_m2);
  if (Number.isFinite(g) && g > 0) {
    const gText = g >= 1 ? `${roundTo(g, 2)} kg/m²` : `${roundTo(g * 1000, 0)} g/m²`;
    parts.push(gText);
  }
  return parts.length > 0 ? `${alias} (${parts.join(', ')})` : alias;
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
