const CONNECTOR_CATALOG_ICON_BASE_URL = "https://static.vm0.io/";
const CONNECTOR_CATALOG_ICON_KEY_MAX_LENGTH = 1024;
const CONNECTOR_CATALOG_ICON_KEY_PATTERN =
  /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\/)*[a-z0-9]+(?:[-_.][a-z0-9]+)*\.(?:png|svg)$/u;

export function isConnectorCatalogIconKey(key: string): boolean {
  return (
    key.length <= CONNECTOR_CATALOG_ICON_KEY_MAX_LENGTH &&
    CONNECTOR_CATALOG_ICON_KEY_PATTERN.test(key)
  );
}

export function connectorCatalogIconUrl(key: string): string {
  if (!isConnectorCatalogIconKey(key)) {
    throw new Error(`Invalid connector catalog icon key "${key}"`);
  }
  return `${CONNECTOR_CATALOG_ICON_BASE_URL}${key}`;
}
