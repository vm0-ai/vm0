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
  .addHelpText(
    "after",
    `
Examples:
  zero doctor missing-token GITHUB_TOKEN
  zero doctor missing-token LINEAR_API_KEY
  zero doctor missing-token NOTION_TOKEN

Notes:
  - Outputs which connector provides the token and a URL for the user to connect it
  - Use this to guide the user when a required token is not available in the sandbox`,
  )
  .action(
    withErrorHandler(async (tokenName: string) => {
      const connectorType = getConnectorTypeForSecretName(tokenName);
      if (!connectorType) {
        throw new Error(
          `Unknown token: ${tokenName} — not managed by any connector`,
        );
      }

      const { label } = CONNECTOR_TYPES[connectorType];

      const apiUrl = await getApiUrl();
      const parsed = new URL(apiUrl);

      // Transform API host to platform host: www.vm0.ai → app.vm0.ai
      const parts = parsed.hostname.split(".");
      if (parts[0] === "www" || parts[0] === "platform") {
        parts[0] = "app";
      } else if (parts[0] !== "app" && parts[0] !== "localhost") {
        parts.unshift("app");
      }
      parsed.hostname = parts.join(".");

      const agentId = process.env.ZERO_AGENT_ID;
      const path = agentId ? `/team/${agentId}` : "/team";
      const url = `${parsed.origin}${path}?tab=connectors`;

      console.log(`${tokenName} is provided by the ${label} connector.`);
      console.log(`Ask the user to connect it at: ${url}`);
    }),
  );
