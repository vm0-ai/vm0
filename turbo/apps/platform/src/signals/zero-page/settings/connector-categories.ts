import { command, computed, state } from "ccstate";
import {
  CONNECTOR_DISPLAY_CATEGORY_GROUPS,
  CONNECTOR_DISPLAY_CATEGORY_META,
  CONNECTOR_DISPLAY_CATEGORY_ORDER,
  type ConnectorDisplayCategory,
  type ConnectorDisplayCategoryGroup,
} from "@vm0/connectors/connectors";

export interface ConnectorCategorySection<T> {
  category: ConnectorDisplayCategory;
  label: string;
  menuLabel: string;
  connectors: T[];
}

export interface ConnectorCategoryGroup<T> {
  id: ConnectorDisplayCategory | ConnectorDisplayCategoryGroup;
  kind: "category" | "group";
  label: string;
  menuLabel: string;
  sections: [ConnectorCategorySection<T>, ...ConnectorCategorySection<T>[]];
}

export function groupConnectorsByCategory<
  T extends {
    category: ConnectorDisplayCategory;
    connected: boolean;
    label: string;
  },
>(connectors: readonly T[]): ConnectorCategoryGroup<T>[] {
  const grouped = new Map<ConnectorDisplayCategory, T[]>();

  for (const connector of connectors) {
    const items = grouped.get(connector.category);
    if (items) {
      items.push(connector);
    } else {
      grouped.set(connector.category, [connector]);
    }
  }

  const categorySections = CONNECTOR_DISPLAY_CATEGORY_ORDER.flatMap(
    (category) => {
      const items = grouped.get(category);
      if (!items || items.length === 0) {
        return [];
      }
      const sorted = [...items].sort((a, b) => {
        if (a.connected !== b.connected) {
          return a.connected ? -1 : 1;
        }
        return a.label.localeCompare(b.label);
      });
      return [
        {
          category,
          label: CONNECTOR_DISPLAY_CATEGORY_META[category].label,
          menuLabel: CONNECTOR_DISPLAY_CATEGORY_META[category].menuLabel,
          connectors: sorted,
        },
      ];
    },
  );

  const groups: ConnectorCategoryGroup<T>[] = [];

  for (const section of categorySections) {
    const meta = CONNECTOR_DISPLAY_CATEGORY_META[section.category];
    if (!meta.group) {
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
      return group.kind === "group" && group.id === meta.group;
    });
    if (existingGroup) {
      existingGroup.sections.push(section);
      continue;
    }

    groups.push({
      id: meta.group,
      kind: "group",
      label: CONNECTOR_DISPLAY_CATEGORY_GROUPS[meta.group].label,
      menuLabel: CONNECTOR_DISPLAY_CATEGORY_GROUPS[meta.group].menuLabel,
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
