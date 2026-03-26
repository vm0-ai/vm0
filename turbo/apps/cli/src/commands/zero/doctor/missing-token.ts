import { Command } from "commander";
import { getConnectorTypeForSecretName, CONNECTOR_TYPES } from "@vm0/core";
import { getApiUrl } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";

export const missingTokenCommand = new Command()
  .name("missing-token")
  .description(
    "Diagnose a missing token and find the connector that provides it",
  )
  .argument("<token-name>", "The environment variable / token name to look up")
  .action(
    withErrorHandler(async (tokenName: string) => {
      const connectorType = getConnectorTypeForSecretName(tokenName);
      if (!connectorType) {
        throw new Error(
          `Unknown token: ${tokenName} — not managed by any connector`,
        );
      }

      const { label } = CONNECTOR_TYPES[connectorType];

      const baseUrl = await getApiUrl();
      const agentId = process.env.ZERO_AGENT_ID;
      const path = agentId ? `/team/${agentId}` : "/team";
      const url = `${baseUrl}${path}?tab=connectors`;

      console.log(`${tokenName} is provided by the ${label} connector.`);
      console.log(`Ask the user to connect it at: ${url}`);
    }),
  );
