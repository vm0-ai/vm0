import { Command } from "commander";
import chalk from "chalk";
import {
  getZeroAgent,
  getZeroAgentCustomConnectors,
  getZeroCustomConnector,
  listZeroCustomConnectors,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { createCustomConnectorCommand } from "./create";

const LABEL_WIDTH = 18;

function renderConnected(connector: {
  readonly connected: boolean;
  readonly missingRequiredFields: readonly string[];
}): string {
  if (connector.connected) {
    return chalk.green("connected");
  }
  if (connector.missingRequiredFields.length === 0) {
    return chalk.dim("not connected");
  }
  return chalk.yellow(`missing ${connector.missingRequiredFields.join(", ")}`);
}

async function resolveCustomAgentContext(agentId: string | undefined): Promise<{
  readonly agentId: string;
  readonly displayName: string;
  readonly authorizedIds: Set<string>;
} | null> {
  const resolvedAgentId = agentId ?? process.env.ZERO_AGENT_ID;
  if (!resolvedAgentId) {
    return null;
  }
  const [agent, enabledIds] = await Promise.all([
    getZeroAgent(resolvedAgentId),
    getZeroAgentCustomConnectors(resolvedAgentId),
  ]);
  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedIds: new Set(enabledIds),
  };
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List org custom connectors")
  .option("--agent <id>", "Show per-agent authorization column")
  .action(
    withErrorHandler(async (options: { agent?: string }) => {
      const [connectors, agentCtx] = await Promise.all([
        listZeroCustomConnectors(),
        resolveCustomAgentContext(options.agent),
      ]);
      const idWidth = Math.max(
        2,
        ...connectors.map((connector) => {
          return connector.id.length;
        }),
      );
      const nameWidth = Math.max(
        4,
        ...connectors.map((connector) => {
          return connector.displayName.length;
        }),
      );
      const header = ["ID".padEnd(idWidth), "NAME".padEnd(nameWidth), "STATUS"];
      if (agentCtx) {
        header.push(`AUTHORIZED FOR ${agentCtx.displayName}`);
      }
      console.log(chalk.dim(header.join("  ")));
      for (const connector of connectors) {
        const row = [
          connector.id.padEnd(idWidth),
          connector.displayName.padEnd(nameWidth),
          renderConnected(connector),
        ];
        if (agentCtx) {
          row.push(
            agentCtx.authorizedIds.has(connector.id)
              ? chalk.green("✓")
              : chalk.dim("-"),
          );
        }
        console.log(row.join("  "));
      }
    }),
  );

const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a custom connector")
  .argument("<connector-id>", "Custom connector id")
  .option("--agent <id>", "Show authorization state for the given agent")
  .action(
    withErrorHandler(
      async (connectorId: string, options: { agent?: string }) => {
        const [connector, agentCtx] = await Promise.all([
          getZeroCustomConnector(connectorId),
          resolveCustomAgentContext(options.agent),
        ]);
        if (!connector) {
          throw new Error(`Custom connector not found: ${connectorId}`);
        }
        console.log(`Custom connector: ${chalk.cyan(connector.displayName)}`);
        console.log();
        console.log(`${"ID:".padEnd(LABEL_WIDTH)}${connector.id}`);
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${renderConnected(connector)}`,
        );
        console.log(
          `${"Prefixes:".padEnd(LABEL_WIDTH)}${connector.prefixTemplates.join(", ")}`,
        );
        console.log(
          `${"Fields:".padEnd(LABEL_WIDTH)}${connector.fields
            .map((field) => {
              return `${field.kind}:${field.key}${field.required ? "" : "?"}`;
            })
            .join(", ")}`,
        );
        if (connector.headerInjections.length > 0) {
          console.log(
            `${"Headers:".padEnd(LABEL_WIDTH)}${connector.headerInjections
              .map((header) => {
                return header.name;
              })
              .join(", ")}`,
          );
        }
        if (connector.queryInjections.length > 0) {
          console.log(
            `${"Query params:".padEnd(LABEL_WIDTH)}${connector.queryInjections
              .map((query) => {
                return query.name;
              })
              .join(", ")}`,
          );
        }
        if (agentCtx) {
          console.log(
            `${"Authorized:".padEnd(LABEL_WIDTH)}${
              agentCtx.authorizedIds.has(connector.id)
                ? chalk.green("yes")
                : chalk.yellow("no")
            }`,
          );
        }
      },
    ),
  );

export const customConnectorCommand = new Command()
  .name("custom")
  .description("Create and inspect org custom connectors")
  .addCommand(createCustomConnectorCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand);
