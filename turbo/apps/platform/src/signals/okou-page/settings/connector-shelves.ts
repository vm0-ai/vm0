import type { ConnectorCategorySection } from "./connector-categories.ts";

/**
 * A shelf is one category shown six deep, closed by a cell that names what is
 * behind it. It exists because a catalog of four thousand connectors cannot be
 * browsed by a filter: the person opening it does not know the product's name,
 * so the surface has to say "Lark, Zendesk and 321 more" rather than "327".
 */
export interface ConnectorShelf<T> {
  /** The category this shelf opens, or null for the cross-category head. */
  readonly category: string | null;
  readonly label: string;
  /** What the shelf shows. */
  readonly connectors: readonly T[];
  /** Up to three marks named in the closing cell. */
  readonly tail: readonly T[];
  /** How many the closing cell stands for. */
  readonly remaining: number;
}

/** A category too thinly ranked to fill a shelf; offered as a counted chip. */
export interface ConnectorShelfChip {
  readonly category: string;
  readonly label: string;
  readonly total: number;
}

export interface ConnectorShelfLayout<T> {
  readonly shelves: readonly ConnectorShelf<T>[];
  readonly chips: readonly ConnectorShelfChip[];
  /** Every connector the layout renders, in reading order. */
  readonly connectors: readonly T[];
}

interface ShelfConnector {
  readonly slug: string;
  readonly label: string;
  readonly popularityRank?: number;
}

/** How many a shelf shows before it closes. */
const CONNECTOR_SHELF_PREVIEW = 6;

/**
 * A category needs this many ranked connectors to earn a shelf. Below it the
 * shelf would fill with the alphabet — Voice and audio would open on "3Scribe,
 * AiVOOV, Amara" — which reads as a broken catalog rather than a short one.
 */
const CONNECTOR_SHELF_MIN_RANKED = 4;

const UNRANKED = Number.MAX_SAFE_INTEGER;

function rankOf(connector: ShelfConnector): number {
  return connector.popularityRank ?? UNRANKED;
}

function byRank<T extends ShelfConnector>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const delta = rankOf(left) - rankOf(right);
    return delta === 0 ? left.label.localeCompare(right.label) : delta;
  });
}

function rankedCount(items: readonly ShelfConnector[]): number {
  return items.filter((item) => {
    return rankOf(item) !== UNRANKED;
  }).length;
}

function totalOf(
  section: ConnectorCategorySection<unknown>,
  counts: Readonly<Record<string, number>> | undefined,
): number {
  return counts?.[section.category] ?? section.connectors.length;
}

/**
 * The head shelf takes the best-ranked connector from each shelf-worthy
 * category rather than the globally top-ranked six, which would be six Google
 * products in a row and would tell a first-time visitor nothing about breadth.
 */
function headConnectors<T extends ShelfConnector>(
  sections: readonly { readonly connectors: readonly T[] }[],
  previewSize: number,
): T[] {
  return byRank(
    sections.flatMap((section) => {
      const best = section.connectors[0];
      return best !== undefined && rankOf(best) !== UNRANKED ? [best] : [];
    }),
  ).slice(0, previewSize);
}

/**
 * Splits the catalog into shelves. A connector appears on exactly one shelf:
 * whatever the head shelf shows does not come back under its own category,
 * which is what keeps Gmail and Slack from opening two sections in a row.
 */
export function buildConnectorShelves<T extends ShelfConnector>({
  sections,
  categoryCounts,
  headLabel,
  previewSize = CONNECTOR_SHELF_PREVIEW,
  minRanked = CONNECTOR_SHELF_MIN_RANKED,
}: {
  readonly sections: readonly ConnectorCategorySection<T>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly headLabel: string;
  readonly previewSize?: number;
  readonly minRanked?: number;
}): ConnectorShelfLayout<T> {
  const ordered = sections.map((section) => {
    return { section, connectors: byRank(section.connectors) };
  });
  const ranked = ordered.filter((entry) => {
    return rankedCount(entry.connectors) >= minRanked;
  });
  // An API that predates discovery ranking sends no rank at all, and a catalog
  // can be filtered down to nothing ranked. Either way the reader must still
  // get shelves rather than an empty sheet, so every category keeps one and
  // the head shelf — which only means something against a ranking — is
  // dropped. See docs/deployment-compatibility.md.
  const rankAware = ranked.length > 0;
  const eligible = rankAware ? ranked : ordered;
  const chips = rankAware
    ? ordered
        .filter((entry) => {
          return rankedCount(entry.connectors) < minRanked;
        })
        .map((entry) => {
          return {
            category: entry.section.category,
            label: entry.section.menuLabel,
            total: totalOf(entry.section, categoryCounts),
          };
        })
    : [];

  const shelves: ConnectorShelf<T>[] = [];
  const used = new Set<string>();
  const head = rankAware ? headConnectors(eligible, previewSize) : [];
  if (head.length > 0) {
    for (const connector of head) {
      used.add(connector.slug);
    }
    const catalogTotal = categoryCounts
      ? Object.values(categoryCounts).reduce((sum, count) => {
          return sum + count;
        }, 0)
      : undefined;
    const rest = byRank(
      eligible.flatMap((entry) => {
        return entry.connectors;
      }),
    ).filter((connector) => {
      return !used.has(connector.slug);
    });
    shelves.push({
      category: null,
      label: headLabel,
      connectors: head,
      tail: catalogTotal === undefined ? [] : rest.slice(0, 3),
      remaining:
        catalogTotal === undefined
          ? 0
          : Math.max(catalogTotal - head.length, 0),
    });
  }

  for (const entry of eligible) {
    const available = entry.connectors.filter((connector) => {
      return !used.has(connector.slug);
    });
    // Only ranked connectors reach a shelf; the alphabet stays in the tail.
    const preview = (
      rankAware
        ? available.filter((connector) => {
            return rankOf(connector) !== UNRANKED;
          })
        : available
    ).slice(0, previewSize);
    if (preview.length === 0) {
      continue;
    }
    for (const connector of preview) {
      used.add(connector.slug);
    }
    const remainder = available.filter((connector) => {
      return !used.has(connector.slug);
    });
    shelves.push({
      category: entry.section.category,
      label: entry.section.label,
      connectors: preview,
      tail: remainder.slice(0, 3),
      remaining: Math.max(
        totalOf(entry.section, categoryCounts) - preview.length,
        0,
      ),
    });
  }

  return {
    shelves,
    chips,
    connectors: shelves.flatMap((shelf) => {
      return shelf.connectors;
    }),
  };
}
