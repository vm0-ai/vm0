import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { connectorChangedPayloadSchema } from "@vm0/api-contracts/contracts/realtime";

export function isConnectorChangedPayloadFor(
  payload: unknown,
  connectorSlug: ConnectorSlug,
): boolean {
  const parsed = connectorChangedPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.connectorSlug === connectorSlug;
}
