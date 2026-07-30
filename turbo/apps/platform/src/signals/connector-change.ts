import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";

export function isConnectorChangedPayloadFor(
  payload: unknown,
  connectorSlug: ConnectorSlug,
): boolean {
  // Old API deployments publish null during a rolling deployment.
  if (payload === null) {
    return true;
  }
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  // TODO(#23821): Remove the legacy realtime payload fallback.
  const candidate =
    "connectorSlug" in payload
      ? payload.connectorSlug
      : "connectorRef" in payload
        ? payload.connectorRef
        : undefined;
  const parsed = connectorSlugSchema.safeParse(candidate);
  return parsed.success && parsed.data === connectorSlug;
}
