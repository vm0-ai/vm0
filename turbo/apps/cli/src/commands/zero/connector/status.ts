import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  connectorTypeSchema,
} from "@vm0/connectors/connectors";
import {
  getConnectorEnvironmentMapping,
  getScopeDiff,
  hasRequiredScopes,
} from "@vm0/connectors/connector-utils";
import { getZeroConnector } from "../../../lib/api";
import { formatDateTime } from "../../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "./agent-context";
import { getPlatformOrigin } from "../doctor/platform-url";

const LABEL_WIDTH = 16;

function getDoctorCommand(type: ConnectorType): string | null {
  const [envName] = Object.keys(getConnectorEnvironmentMapping(type));
  return envName ? `zero doctor check-connector --env-name ${envName}` : null;
}

function printDoctorHint(type: ConnectorType): void {
  const command = getDoctorCommand(type);
  if (command) {
    console.log(`Diagnose it with: ${command}`);
  } else {
    console.log("Having trouble? Run: zero doctor --help");
  }
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a connector")
  .argument("<type>", "Connector type (e.g., github)")
  .option("--agent <id>", "Show authorization state for the given agent")
  .action(
    withErrorHandler(async (type: string, options: { agent?: string }) => {
      const parseResult = connectorTypeSchema.safeParse(type);
      if (!parseResult.success) {
        const available = Object.keys(CONNECTOR_TYPES).join(", ");
        throw new Error(`Unknown connector type: ${type}`, {
          cause: new Error(`Available connectors: ${available}`),
        });
      }

      const [connector, agentCtx] = await Promise.all([
        getZeroConnector(parseResult.data),
        resolveAgentContext(options.agent),
      ]);

      console.log(`Connector: ${chalk.cyan(type)}`);
      console.log();

      if (connector) {
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${chalk.green("connected")}`,
        );
        console.log(
          `${"Account:".padEnd(LABEL_WIDTH)}@${connector.externalUsername}`,
        );
        console.log(
          `${"Auth Method:".padEnd(LABEL_WIDTH)}${connector.authMethod}`,
        );

        if (connector.oauthScopes && connector.oauthScopes.length > 0) {
          console.log(
            `${"OAuth Scopes:".padEnd(LABEL_WIDTH)}${connector.oauthScopes.join(", ")}`,
          );
        }

        if (
          connector.authMethod === "oauth" &&
          !hasRequiredScopes(parseResult.data, connector.oauthScopes)
        ) {
          const diff = getScopeDiff(parseResult.data, connector.oauthScopes);
          console.log(
            `${"Permissions:".padEnd(LABEL_WIDTH)}${chalk.yellow("update available")}`,
          );
          if (diff.addedScopes.length > 0) {
            console.log(
              `${"  Added:".padEnd(LABEL_WIDTH)}${diff.addedScopes.join(", ")}`,
            );
          }
          if (diff.removedScopes.length > 0) {
            console.log(
              `${"  Removed:".padEnd(LABEL_WIDTH)}${diff.removedScopes.join(", ")}`,
            );
          }
        }

        console.log(
          `${"Connected:".padEnd(LABEL_WIDTH)}${formatDateTime(connector.createdAt)}`,
        );

        if (connector.updatedAt !== connector.createdAt) {
          console.log(
            `${"Last Updated:".padEnd(LABEL_WIDTH)}${formatDateTime(connector.updatedAt)}`,
          );
        }
      } else {
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${chalk.dim("not connected")}`,
        );
      }

      if (agentCtx) {
        const authorized = agentCtx.authorizedTypes.has(parseResult.data);
        const isConnected = connector !== null;
        const agentLabel =
          agentCtx.displayName === agentCtx.agentId
            ? agentCtx.agentId
            : `${agentCtx.displayName} (${agentCtx.agentId})`;

        console.log();
        if (authorized && !isConnected) {
          const origin = await getPlatformOrigin();
          const url = `${origin}/connectors/${parseResult.data}/connect?agentId=${agentCtx.agentId}`;
          console.log(
            `The ${parseResult.data} connector is authorized for agent ${agentLabel}, but it is not connected.`,
          );
          console.log(`Connect it at: [Connect ${parseResult.data}](${url})`);
          printDoctorHint(parseResult.data);
        } else if (authorized) {
          console.log(
            `The ${parseResult.data} connector is authorized for agent ${agentLabel}.`,
          );
        } else if (!isConnected) {
          const origin = await getPlatformOrigin();
          const url = `${origin}/connectors/${parseResult.data}/connect?agentId=${agentCtx.agentId}`;
          console.log(
            `The ${parseResult.data} connector is not connected. Once connected, it will be authorized for agent ${agentLabel}.`,
          );
          console.log(`Connect it at: [Connect ${parseResult.data}](${url})`);
          printDoctorHint(parseResult.data);
        } else {
          const origin = await getPlatformOrigin();
          const url = `${origin}/connectors/${parseResult.data}/authorize?agentId=${agentCtx.agentId}`;
          console.log(
            `The ${parseResult.data} connector is not authorized for agent ${agentLabel}.`,
          );
          console.log(
            `Authorize it at: [Authorize ${parseResult.data}](${url})`,
          );
        }
      } else if (!connector) {
        console.log();
        printDoctorHint(parseResult.data);
      }
    }),
  );
