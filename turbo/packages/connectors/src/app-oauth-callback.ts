// Add a connector only after its OAuth app accepts the App callback URL.
const ENABLED_CONNECTOR_REFS: ReadonlySet<string> = new Set(["github"]);

export function isConnectorAppOauthCallbackEnabled(
  connectorRef: string,
): boolean {
  return ENABLED_CONNECTOR_REFS.has(connectorRef);
}
