/**
 * Parser eksportu SAP „Task List Print List” / routing (.txt).
 * Struktura:
 *   Material <SAP> …          ← wyrób gotowy lub komponent (np. S2102)
 *   …
 *   Operation … Base Qty …
 *   Mat. Comp. <SAP>  <KOD> … ← komponent BOM (np. S2102, S1619)
 */

export type SapRoutingComponent = {
  /** Numer materiału komponentu (Mat. Comp.) */
  materialNumber: string;
  /** Kod typu z opisu, np. S2102 / S1619 */
  code: string;
  description: string;
  /** Wersja BOM z linii „Alt. N” (1 = podstawowa). */
  bomAlt: number | null;
  /** Zużycie komponentu na jedną sztukę detalu (Qty z eksportu SAP / 1000). */
  bomQuantityPerDetail: number | null;
  /** Pole powierzchni z wymiarów L×W w opisie (jeśli da się odczytać). */
  area: number | null;
  /** Długość [mm] z opisu (pierwszy wymiar). */
  length: number | null;
  /** Szerokość [mm] z opisu (drugi wymiar). */
  width: number | null;
};

/** Tylko podstawowa wersja BOM (Alt. 1). Brak znacznika traktujemy jak Alt. 1. */
export function isPrimaryBomAlt(alt: number | null | undefined): boolean {
  return alt == null || alt === 1;
}

function peekBomMeta(
  lines: string[],
  fromIndex: number
): { alt: number | null; quantityPerDetail: number | null } {
  const bomAltRe = /\bAlt\.\s*(\d+)\b/i;
  const qtyRe = /\bQty\s+([\d.,]+)/i;
  const stopRe = /^\s*(Material\s+\d+|Mat\.\s*Comp\.|Sequence|Operation)\b/i;
  const limit = Math.min(lines.length, fromIndex + 8);
  for (let i = fromIndex; i < limit; i++) {
    const line = lines[i].replace(/\u00a0/g, ' ');
    if (i > fromIndex && stopRe.test(line)) break;
    const altMatch = bomAltRe.exec(line);
    if (altMatch) {
      const alt = Number(altMatch[1]);
      const rawQuantity = qtyRe.exec(line);
      const parsedQuantity = rawQuantity ? parseEuNumber(rawQuantity[1]) : null;
      return {
        alt: Number.isFinite(alt) ? alt : null,
        quantityPerDetail:
          parsedQuantity != null && parsedQuantity >= 0 ? parsedQuantity / 1000 : null,
      };
    }
  }
  return { alt: null, quantityPerDetail: null };
}

export type SapRoutingIndex = {
  /** Wyrób SAP → unikalne komponenty (kolejność pierwszego wystąpienia). */
  byFinishedGood: Map<string, SapRoutingComponent[]>;
  /** Materiały mające operację „Produkcja HL” na stanowisku B03-002. */
  capacityMaterials: Set<string>;
  /**
   * Base Qty z pierwszej operacji bloku Material (klucz = numer materiału).
   * Używane dla S2102 → kolumny CY / DK.
   */
  baseQtyByMaterial: Map<string, number>;
  finishedGoods: number;
  componentRows: number;
};

function normSap(v: string): string {
  return String(v ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/\.0+$/, '');
}

/** EU: 1.000 → 1000; 0,500 → 0.5 */
export function parseEuNumber(raw: string): number | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Wymiary L×W z opisu. */
export function parseFormatkaDimensions(
  description: string
): { length: number; width: number; area: number } | null {
  const s = String(description ?? '');
  const m = s.match(/(\d{2,5})\s*[xX×]\s*(\d{2,5})/);
  if (!m) return null;
  const length = Number(m[1]);
  const width = Number(m[2]);
  if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) return null;
  return { length, width, area: length * width };
}

/** Wyciąga pole powierzchni z wymiarów WxH w opisie. */
export function parseFormatkaArea(description: string): number | null {
  return parseFormatkaDimensions(description)?.area ?? null;
}

/**
 * Parsuje tekst routingu SAP.
 * Dla każdego wyrobu zbiera komponenty; duplikaty (ten sam Mat. Comp. + kod) są pomijane.
 * Komponenty z BOM Alt. 2 i wyżej są pomijane (zostaje tylko Alt. 1).
 * Base Qty zbierane z operacji każdego bloku Material.
 */
export function parseSapRoutingText(text: string): SapRoutingIndex {
  const lines = String(text ?? '').split(/\r?\n/);
  const byFinishedGood = new Map<string, SapRoutingComponent[]>();
  const baseQtyByMaterial = new Map<string, number>();
  const capacityMaterials = new Set<string>();
  const seenInFg = new Map<string, Set<string>>();

  let currentFg: string | null = null;
  let finishedGoods = 0;
  let componentRows = 0;

  const materialRe = /^Material\s+(\d+)\b/i;
  const compRe = /^\s*Mat\.\s*Comp\.\s+(\d+)\s+(\S+)\s*(.*)$/i;
  const baseQtyRe = /^\s*Base\s+Qty\s+([\d.,]+)/i;
  const operationRe =
    /^\s*Operation\b.*\bWork\s+Ctr\s+B03-002\b.*\bProdukcja\s+HL\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\u00a0/g, ' ');
    const mat = materialRe.exec(line);
    if (mat) {
      currentFg = normSap(mat[1]);
      if (currentFg && !byFinishedGood.has(currentFg)) {
        byFinishedGood.set(currentFg, []);
        seenInFg.set(currentFg, new Set());
        finishedGoods++;
      }
      continue;
    }

    if (!currentFg) continue;

    if (operationRe.test(line)) capacityMaterials.add(currentFg);

    const bq = baseQtyRe.exec(line);
    if (bq && !baseQtyByMaterial.has(currentFg)) {
      const qty = parseEuNumber(bq[1]);
      if (qty != null && qty > 0) baseQtyByMaterial.set(currentFg, qty);
    }

    const cm = compRe.exec(line);
    if (!cm) continue;

    componentRows++;
    const materialNumber = normSap(cm[1]);
    const code = String(cm[2] ?? '')
      .trim()
      .toUpperCase();
    const description = String(cm[3] ?? '').trim();
    if (!materialNumber || !code) continue;

    const bomMeta = peekBomMeta(lines, i + 1);
    const bomAlt = bomMeta.alt;
    if (!isPrimaryBomAlt(bomAlt)) continue;

    const dedupeKey = `${materialNumber}|${code}`;
    const seen = seenInFg.get(currentFg)!;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const dims = parseFormatkaDimensions(`${code} ${description}`);
    byFinishedGood.get(currentFg)!.push({
      materialNumber,
      code,
      description,
      bomAlt: bomAlt ?? 1,
      bomQuantityPerDetail: bomMeta.quantityPerDetail,
      area: dims?.area ?? null,
      length: dims?.length ?? null,
      width: dims?.width ?? null,
    });
  }

  if (!byFinishedGood.size) {
    throw new Error('Routing SAP: nie znaleziono żadnego nagłówka „Material …”.');
  }

  return { byFinishedGood, baseQtyByMaterial, capacityMaterials, finishedGoods, componentRows };
}

export function parseSapRoutingBuffer(buffer: Buffer): SapRoutingIndex {
  // pliki SAP bywają w Windows-1250 / UTF-8 — najpierw UTF-8, potem latin2-ish
  let text = buffer.toString('utf8');
  if (text.includes('\uFFFD') || /Material\s+\d+/.test(text) === false) {
    // próba cp1250 przez iconv nie jest w deps — fallback: binary latin1 (zachowuje cyfry/ASCII)
    text = buffer.toString('latin1');
  }
  return parseSapRoutingText(text);
}

/** Komponenty o danym kodzie (prefiks, np. S2102) — tylko bezpośrednie dzieci Material. */
export function componentsWithCode(
  index: SapRoutingIndex,
  finishedGoodSap: string,
  codePrefix: string
): SapRoutingComponent[] {
  const fg = normSap(finishedGoodSap);
  const list = index.byFinishedGood.get(fg) ?? [];
  const prefix = codePrefix.trim().toUpperCase();
  return list.filter((c) => c.code === prefix || c.code.startsWith(prefix));
}

/**
 * Komponenty o danym kodzie z wielopoziomowego BOM (BFS po Mat. Comp. → ich bloki Material).
 * Np. FG → półprodukt → S2102 / S1619 na niższym poziomie.
 */
export function componentsWithCodeDeep(
  index: SapRoutingIndex,
  finishedGoodSap: string,
  codePrefix: string,
  maxDepth = 8
): SapRoutingComponent[] {
  const root = normSap(finishedGoodSap);
  if (!root) return [];
  const prefix = codePrefix.trim().toUpperCase();
  if (!prefix) return [];

  const found: SapRoutingComponent[] = [];
  const foundKeys = new Set<string>();
  const visited = new Set<string>([root]);
  const queue: { sap: string; depth: number }[] = [{ sap: root, depth: 0 }];

  while (queue.length) {
    const { sap, depth } = queue.shift()!;
    const list = index.byFinishedGood.get(sap) ?? [];
    for (const c of list) {
      if (c.code === prefix || c.code.startsWith(prefix)) {
        const key = `${c.materialNumber}|${c.code}`;
        if (!foundKeys.has(key)) {
          foundKeys.add(key);
          found.push(c);
        }
      }
      if (depth + 1 >= maxDepth) continue;
      const child = normSap(c.materialNumber);
      if (!child || visited.has(child) || !index.byFinishedGood.has(child)) continue;
      visited.add(child);
      queue.push({ sap: child, depth: depth + 1 });
    }
  }

  return found;
}

/**
 * Komponenty o danym kodzie: bezpośrednio pod wyrobem oraz wewnątrz wskazanych
 * półproduktów (np. C21Q1), o ile ich bloki Material są w tym samym pliku.
 * W odróżnieniu od componentsWithCodeDeep nie schodzi przez pozostałe kody,
 * więc nie wciąga materiałów z niepowiązanych gałęzi BOM ani z zagnieżdżonych
 * bloków samego szukanego materiału.
 */
export function componentsWithCodeViaSubassemblies(
  index: SapRoutingIndex,
  finishedGoodSap: string,
  codePrefix: string,
  subassemblyPrefixes: string[],
  maxDepth = 4
): SapRoutingComponent[] {
  const root = normSap(finishedGoodSap);
  const prefix = codePrefix.trim().toUpperCase();
  if (!root || !prefix) return [];
  const subPrefixes = subassemblyPrefixes
    .map((p) => String(p ?? '').trim().toUpperCase())
    .filter(Boolean);

  const found: SapRoutingComponent[] = [];
  const foundKeys = new Set<string>();
  const visited = new Set<string>([root]);
  const queue: { sap: string; depth: number; quantityFactor: number }[] = [
    { sap: root, depth: 0, quantityFactor: 1 },
  ];

  while (queue.length) {
    const { sap, depth, quantityFactor } = queue.shift()!;
    for (const c of index.byFinishedGood.get(sap) ?? []) {
      if (c.code === prefix || c.code.startsWith(prefix)) {
        const key = `${c.materialNumber}|${c.code}`;
        if (!foundKeys.has(key)) {
          foundKeys.add(key);
          found.push({
            ...c,
            bomQuantityPerDetail:
              (c.bomQuantityPerDetail ?? 1) * quantityFactor,
          });
        }
        continue;
      }
      if (depth + 1 >= maxDepth) continue;
      if (!subPrefixes.some((p) => c.code === p || c.code.startsWith(p))) continue;
      const child = normSap(c.materialNumber);
      if (!child || visited.has(child) || !index.byFinishedGood.has(child)) continue;
      visited.add(child);
      queue.push({
        sap: child,
        depth: depth + 1,
        quantityFactor: quantityFactor * (c.bomQuantityPerDetail ?? 1),
      });
    }
  }

  return found;
}

/**
 * Dzieli komponenty S2102 na większą i mniejszą formatkę wg pola powierzchni.
 * - jedna klasa rozmiaru → tylko „large”
 * - wiele → max area = large, pozostałe (mniejsze) = small
 * Przy braku wymiarów: pierwszy unikalny → large, kolejne → small (ostrożnie).
 */
export function splitS2102ByFormatka(comps: SapRoutingComponent[]): {
  large: SapRoutingComponent[];
  small: SapRoutingComponent[];
} {
  if (!comps.length) return { large: [], small: [] };

  const withArea = comps.filter((c) => c.area != null && c.area > 0);
  const withoutArea = comps.filter((c) => c.area == null || c.area <= 0);

  if (withArea.length === 0) {
    // brak wymiarów — nie zgadujemy „większa/mniejsza”: pierwszy do large, reszta small tylko gdy >1
    if (comps.length === 1) return { large: comps, small: [] };
    return { large: [comps[0]], small: comps.slice(1) };
  }

  const maxArea = Math.max(...withArea.map((c) => c.area!));
  const large = withArea.filter((c) => c.area === maxArea);
  const small = [...withArea.filter((c) => c.area! < maxArea), ...withoutArea];
  return { large, small };
}

/** Wartość do komórki: numer materiału jako liczba gdy to czysty int. */
export function materialCellValue(materialNumber: string): string | number {
  const s = normSap(materialNumber);
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(Math.trunc(n)) === s) return n;
  }
  return s;
}

/** Base Qty dla numeru materiału (blok Material w routingu). */
export function baseQtyForMaterial(index: SapRoutingIndex, materialNumber: string): number | null {
  const n = normSap(materialNumber);
  const qty = index.baseQtyByMaterial.get(n);
  return qty != null && Number.isFinite(qty) ? qty : null;
}
