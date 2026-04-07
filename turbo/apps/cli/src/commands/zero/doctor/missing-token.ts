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
import { toPlatformUrl } from "./platform-url";

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

      // Check whether the token actually exists in the sandbox environment.
      const tokenPresent = Boolean(process.env[tokenName]);
      console.log(
        `${tokenName} is provided by the ${label} connector. Sandbox env: ${tokenPresent ? "present" : "not present"}.`,
      );

      // Check whether the user has connected this connector and whether the
      // agent has permission to use it. Run both checks in parallel.
      const [connector, enabledTypes] = await Promise.all([
        getZeroConnector(connectorType as ConnectorType).catch(() => {
          return null;
        }),
        agentId
          ? getZeroAgentUserConnectors(agentId).catch(() => {
              return null;
            })
          : Promise.resolve(null),
      ]);

      const isConnected = connector !== null;
      const hasPermission =
        enabledTypes !== null && enabledTypes.includes(connectorType);

      const rediagnoseHint = `Important: if ${tokenName} is still missing after the user takes action, run \`zero doctor missing-token ${tokenName}\` again to re-diagnose instead of assuming the status.`;

      if (!isConnected) {
        // Connector not connected — direct to the directed connect page
        const connectUrl = agentId
          ? `${platformUrl.origin}/connectors/${connectorType}/connect?agentId=${agentId}`
          : `${platformUrl.origin}/connectors/${connectorType}/connect`;
        console.log(
          `The ${label} connector is not connected. Ask the user to connect it at: [Connect ${label}](${connectUrl})\n${rediagnoseHint}`,
        );
        return;
      }

      const issues: string[] = [];

      if (connector.needsReconnect) {
        const url = `${platformUrl.origin}/connectors`;
        issues.push(
          `The ${label} connector has expired and needs to be reconnected. Ask the user to reconnect it at: [Reconnect ${label}](${url})`,
        );
      }

      if (!hasPermission) {
        const url = agentId
          ? `${platformUrl.origin}/connectors/${connectorType}/authorize?agentId=${agentId}`
          : `${platformUrl.origin}/connectors`;
        issues.push(
          `The ${label} connector is not authorized for this agent. Ask the user to enable it at: [Authorize ${label}](${url})`,
        );
      }

      if (issues.length > 0) {
        for (const issue of issues) {
          console.log(issue);
        }
        console.log(rediagnoseHint);
      } else {
        // Both connected and authorized — something else is wrong
        const url = `${platformUrl.origin}/connectors`;
        console.log(
          `The ${label} connector is connected and authorized, but the token is still missing. Ask VM0 developer to resolve this issue. Connector status: [Check ${label} status](${url})\n${rediagnoseHint}`,
        );
      }
    }),
  );
