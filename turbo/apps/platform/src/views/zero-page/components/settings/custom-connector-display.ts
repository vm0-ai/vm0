import type { CustomConnectorClientResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";

export function customConnectorTarget(
  connector: CustomConnectorClientResponse,
): string {
  return connector.kind === "mcp"
    ? connector.endpoint
    : connector.prefixTemplates.join(", ");
}
