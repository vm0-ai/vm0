import { command, computed, state } from "ccstate";
import type { PublicConnectorCatalogCategoryMetadata } from "@vm0/api-contracts/contracts/zero-connector-catalog";

export interface ConnectorCategorySection<T> {
  category: string;
  label: string;
  menuLabel: string;
  groupId: string | null;
  connectors: T[];
}

export interface ConnectorCategoryGroup<T> {
  id: string;
  kind: "category" | "group";
  label: string;
  menuLabel: string;
  sections: [ConnectorCategorySection<T>, ...ConnectorCategorySection<T>[]];
}

function fallbackCategoryLabel(category: string): string {
  const label = category
    .split(/[-_\s]+/)
    .filter((part) => {
      return part.length > 0;
    })
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
  return label || "Other";
}

function sortedCategoryConnectors<
  T extends {
    connected: boolean;
    label: string;
  },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.connected !== b.connected) {
      return a.connected ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

export function groupConnectorsByCategory<
  T extends {
    category: string;
    connected: boolean;
    label: string;
  },
>(
  connectors: readonly T[],
  categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined,
): ConnectorCategoryGroup<T>[] {
  const grouped = new Map<string, T[]>();

  for (const connector of connectors) {
    const items = grouped.get(connector.category);
    if (items) {
      items.push(connector);
    } else {
      grouped.set(connector.category, [connector]);
    }
  }

  const groupedCategoryIds = new Set<string>();
  const categorySections: ConnectorCategorySection<T>[] =
    categoryMetadata?.categories.flatMap((category) => {
      if (groupedCategoryIds.has(category.id)) {
        return [];
      }
      const items = grouped.get(category.id);
      if (!items || items.length === 0) {
        return [];
      }
      groupedCategoryIds.add(category.id);
      return [
        {
          category: category.id,
          label: category.label,
          menuLabel: category.menuLabel,
          groupId: category.groupId,
          connectors: sortedCategoryConnectors(items),
        },
      ];
    }) ?? [];

  for (const [category, items] of grouped) {
    if (groupedCategoryIds.has(category)) {
      continue;
    }
    const label = fallbackCategoryLabel(category);
    categorySections.push({
      category,
      label,
      menuLabel: label,
      groupId: null,
      connectors: sortedCategoryConnectors(items),
    });
  }

  const groups: ConnectorCategoryGroup<T>[] = [];
  const groupMetadata = new Map(
    categoryMetadata?.groups.map((group) => {
      return [group.id, group];
    }) ?? [],
  );

  for (const section of categorySections) {
    if (!section.groupId) {
      groups.push({
        id: section.category,
        kind: "category",
        label: section.label,
        menuLabel: section.menuLabel,
        sections: [section],
      });
      continue;
    }

    const existingGroup = groups.find((group) => {
      return group.kind === "group" && group.id === section.groupId;
    });
    if (existingGroup) {
      existingGroup.sections.push(section);
      continue;
    }

    const metadata = groupMetadata.get(section.groupId);
    const label = metadata?.label ?? fallbackCategoryLabel(section.groupId);
    const menuLabel =
      metadata?.menuLabel ?? fallbackCategoryLabel(section.groupId);
    groups.push({
      id: section.groupId,
      kind: "group",
      label,
      menuLabel,
      sections: [section],
    });
  }

  return groups;
}

export function getConnectorCategorySectionId(category: string): string {
  return `connector-category-${category}`;
}

export function scrollToConnectorCategory(category: string): void {
  document
    .getElementById(getConnectorCategorySectionId(category))
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

const SECTION_ID_PREFIX = "connector-category-";

function getActiveConnectorCategoryId(
  scrollContainer: HTMLElement,
): string | null {
  const sections = Array.from(
    document.querySelectorAll<HTMLElement>(`[id^="${SECTION_ID_PREFIX}"]`),
  ).filter((element) => {
    return scrollContainer.contains(element);
  });
  if (sections.length === 0) {
    return null;
  }
  let activeId: string | null =
    sections[0]?.id.slice(SECTION_ID_PREFIX.length) ?? null;
  const anchorY = scrollContainer.getBoundingClientRect().top + 120;

  for (const section of sections) {
    if (section.getBoundingClientRect().top <= anchorY) {
      activeId = section.id.slice(SECTION_ID_PREFIX.length);
      continue;
    }
    break;
  }

  return activeId;
}

// ---------------------------------------------------------------------------
// Scroll-driven active category tracking
// ---------------------------------------------------------------------------

const internalActiveConnectorCategoryId$ = state<string | null>(null);

export const activeConnectorCategoryId$ = computed((get) => {
  return get(internalActiveConnectorCategoryId$);
});

const setActiveConnectorCategoryId$ = command(
  ({ get, set }, nextActiveId: string | null) => {
    const previous = get(internalActiveConnectorCategoryId$);
    if (previous !== nextActiveId) {
      set(internalActiveConnectorCategoryId$, nextActiveId);
    }
  },
);

export const resetActiveConnectorCategory$ = command(({ set }) => {
  set(internalActiveConnectorCategoryId$, null);
});

/**
 * Attach scroll/resize listeners to update the active category indicator.
 * Returns a cleanup function that removes the listeners. Call from a React
 * callback ref inside an effect-equivalent lifecycle (e.g. component mount).
 */
export const attachConnectorCategoryScrollTracking$ = command(
  ({ set }, scrollContainer: HTMLElement): (() => void) => {
    const updateActiveCategory = () => {
      const nextActiveId = getActiveConnectorCategoryId(scrollContainer);
      set(setActiveConnectorCategoryId$, nextActiveId);
    };

    updateActiveCategory();
    scrollContainer.addEventListener("scroll", updateActiveCategory, {
      passive: true,
    });
    window.addEventListener("resize", updateActiveCategory);

    return () => {
      scrollContainer.removeEventListener("scroll", updateActiveCategory);
      window.removeEventListener("resize", updateActiveCategory);
    };
  },
);
