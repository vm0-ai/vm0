import { Command } from "commander";
import {
  getConnectorTypeForSecretName,
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/core";
import { getApiUrl } from "../../../lib/api/config";
import { getZeroConnector } from "../../../lib/api/domains/zero-connectors";
import { getZeroAgentUserConnectors } from "../../../lib/api/domains/zero-agents";
import { withErrorHandler } from "../../../lib/command";

/**
 * Transform the API host to the platform (app) host.
 *
 *   www.vm0.ai                    → app.vm0.ai
 *   platform.vm0.ai               → app.vm0.ai
 *   tunnel-user-host-www.vm7.ai   → tunnel-user-host-app.vm7.ai
 *   custom.example.com            → app.custom.example.com
 */
function toPlatformUrl(apiUrl: string): URL {
  const parsed = new URL(apiUrl);
  const parts = parsed.hostname.split(".");
  if (parts[0]!.endsWith("-www")) {
    parts[0] = parts[0]!.slice(0, -"-www".length) + "-app";
  } else if (parts[0] === "www" || parts[0] === "platform") {
    parts[0] = "app";
  } else if (parts[0] !== "app" && parts[0] !== "localhost") {
    parts.unshift("app");
  }
  parsed.hostname = parts.join(".");
  return parsed;
}

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
      const platformUrl = toPlatformUrl(apiUrl);
      const agentId = process.env.ZERO_AGENT_ID;

      // Check whether the user has connected this connector and whether the
      // agent has permission to use it. Run both checks in parallel.
      const [connector, enabledTypes] = await Promise.all([
        getZeroConnector(connectorType as ConnectorType).catch(() => null),
        agentId
          ? getZeroAgentUserConnectors(agentId).catch(() => null)
          : Promise.resolve(null),
      ]);

      const isConnected = connector !== null;
      const hasPermission =
        enabledTypes !== null && enabledTypes.includes(connectorType);

      console.log(`${tokenName} is provided by the ${label} connector.`);

      if (!isConnected) {
        // Connector not connected at all — direct to connectors page
        const url = `${platformUrl.origin}/connectors`;
        console.log(
          `The ${label} connector is not connected. Ask the user to connect it at: ${url}`,
        );
      } else if (!hasPermission) {
        // Connected but not authorized for this agent — direct to authorization tab
        const path = agentId ? `/team/${agentId}` : "/team";
        const url = `${platformUrl.origin}${path}?tab=authorization`;
        console.log(
          `The ${label} connector is connected but not authorized for this agent. Ask the user to enable it at: ${url}`,
        );
      } else {
        // Both connected and authorized — something else is wrong
        const url = `${platformUrl.origin}/connectors`;
        console.log(
          `The ${label} connector is connected and authorized, but the token is still missing. Ask the user to check the connector status at: ${url}`,
        );
      }
    }),
  );
