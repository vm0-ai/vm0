import type { FirewallConnectorType } from "./index";

export interface ConnectorCategories {
  /** Map of permission name to category label */
  categories: Record<string, string>;
  /** Display order of categories (first = top of list) */
  displayOrder: readonly string[];
}

const CATEGORY_REGISTRY: Partial<
  Record<FirewallConnectorType, ConnectorCategories>
> = {};

export function registerCategories(
  type: FirewallConnectorType,
  data: ConnectorCategories,
): void {
  CATEGORY_REGISTRY[type] = data;
}

export function getPermissionCategories(
  type: string,
): ConnectorCategories | null {
  return (
    (CATEGORY_REGISTRY as Record<string, ConnectorCategories>)[type] ?? null
  );
}

export interface PermissionGroup<T extends { name: string }> {
  category: string;
  permissions: T[];
}

/**
 * Group permissions by their category for a given connector type.
 * Returns null when the connector has no category data (caller should
 * fall back to a flat list).
 */
export function groupPermissionsByCategory<T extends { name: string }>(
  permissions: T[],
  connectorType: string,
): PermissionGroup<T>[] | null {
  const categoryData = getPermissionCategories(connectorType);
  if (!categoryData) {
    return null;
  }

  const grouped = new Map<string, T[]>();
  for (const category of categoryData.displayOrder) {
    grouped.set(category, []);
  }

  for (const perm of permissions) {
    const category = categoryData.categories[perm.name];
    if (category) {
      const list = grouped.get(category);
      if (list) {
        list.push(perm);
      }
    }
  }

  return [...grouped.entries()]
    .filter(([, perms]) => {
      return perms.length > 0;
    })
    .map(([category, perms]) => {
      return { category, permissions: perms };
    });
}
