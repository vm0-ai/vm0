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
