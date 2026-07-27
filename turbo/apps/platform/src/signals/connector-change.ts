import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { connectorChangedPayloadSchema } from "@vm0/api-contracts/contracts/realtime";

export function isConnectorChangedPayloadFor(
  payload: unknown,
  connectorRef: ConnectorRef,
): boolean {
  // Old API deployments publish null during a rolling deployment.
  if (payload === null) {
    return true;
  }
  const parsed = connectorChangedPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.connectorRef === connectorRef;
}
