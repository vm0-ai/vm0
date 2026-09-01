const CONNECTOR_CATALOG_ICON_KEY_MAX_LENGTH = 1024;
const CONNECTOR_CATALOG_ICON_KEY_PATTERN =
  /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\/)*[a-z0-9]+(?:[-_.][a-z0-9]+)*\.(?:png|svg)$/u;

export function isConnectorCatalogIconKey(key: string): boolean {
  return (
    key.length <= CONNECTOR_CATALOG_ICON_KEY_MAX_LENGTH &&
    CONNECTOR_CATALOG_ICON_KEY_PATTERN.test(key)
  );
}
