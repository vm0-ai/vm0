import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";

export function customConnectorTarget(
  connector: CustomConnectorResponse,
): string {
  return connector.kind === "mcp"
    ? connector.endpoint
    : connector.prefixTemplates.join(", ");
}
