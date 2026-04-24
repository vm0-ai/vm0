import {
  CONNECTOR_DISPLAY_CATEGORY_GROUPS,
  CONNECTOR_DISPLAY_CATEGORY_META,
  CONNECTOR_DISPLAY_CATEGORY_ORDER,
  type ConnectorDisplayCategory,
  type ConnectorDisplayCategoryGroup,
} from "@vm0/core";

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
