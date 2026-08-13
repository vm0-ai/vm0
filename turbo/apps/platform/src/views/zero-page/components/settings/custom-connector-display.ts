import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/zero-custom-connectors";

export function customConnectorTarget(
  connector: CustomConnectorResponse,
): string {
  return connector.kind === "mcp"
    ? connector.endpoint
    : connector.prefixTemplates.join(", ");
}
