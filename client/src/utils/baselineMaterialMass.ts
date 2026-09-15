export function blankMassKg(grammageKgM2: number, widthMm: number, lengthMm: number): number | null {
  if (![grammageKgM2, widthMm, lengthMm].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return Math.round(grammageKgM2 * (widthMm / 1000) * (lengthMm / 1000) * 10000) / 10000;
}
