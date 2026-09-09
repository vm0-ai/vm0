import { Command } from "commander";
import chalk from "chalk";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getAgent,
  getAgentCustomConnectorGrants,
} from "../../../lib/api/domains/agents";
import {
  getCustomConnector,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { resolveConnectorAgentId } from "../agent-context";
import { createCustomConnectorCommand } from "./create";
import { updateCustomConnectorCommand } from "./update";
import { connectorInspectionType } from "../inspection";

const LABEL_WIDTH = 18;

function customConnectorJson(
  connector: CustomConnectorResponse,
  agent: Awaited<ReturnType<typeof resolveCustomAgentContext>>,
) {
  const target = { kind: "custom", customConnectorId: connector.id } as const;
  return {
    ...connector,
    target,
    connectorType: connectorInspectionType(target, connector),
    connectionId: connector.connectedAccountId ?? null,
    authorized: agent ? agent.authorizedIds.has(connector.id) : null,
  };
}

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
  if (!agentId) {
    return null;
  }
  const [agent, grants] = await Promise.all([
    getAgent(agentId),
    getAgentCustomConnectorGrants(agentId),
  ]);
  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedIds: new Set(
      grants.map((grant) => {
        return grant.customConnectorId;
      }),
    ),
  };
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List org custom connectors")
  .option(
    "--agent <id>",
    "Show per-agent authorization column (must match the current Agent inside a run)",
  )
  .option("--json", "Output current org custom connectors as JSON")
  .action(
    withErrorHandler(async (options: { agent?: string; json?: boolean }) => {
      const agentId = resolveConnectorAgentId(options.agent);
      const [connectors, agentCtx] = await Promise.all([
        listCustomConnectors(),
        resolveCustomAgentContext(agentId),
      ]);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              context: "current",
              agent: agentCtx
                ? {
                    agentId: agentCtx.agentId,
                    displayName: agentCtx.displayName,
                  }
                : null,
              connectors: connectors.map((connector) => {
                return customConnectorJson(connector, agentCtx);
              }),
            },
            null,
            2,
          ),
        );
        return;
      }
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
      const header = [
        "ID".padEnd(idWidth),
        "NAME".padEnd(nameWidth),
        "KIND",
        "STATUS",
      ];
      if (agentCtx) {
        header.push(`AUTHORIZED FOR ${agentCtx.displayName}`);
      }
      console.log(chalk.dim(header.join("  ")));
      for (const connector of connectors) {
        const row = [
          connector.id.padEnd(idWidth),
          connector.displayName.padEnd(nameWidth),
          connector.kind,
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
  .option(
    "--agent <id>",
    "Show authorization state for the given Agent (must match the current Agent inside a run)",
  )
  .option("--json", "Output current org custom connector status as JSON")
  .action(
    withErrorHandler(
      async (
        connectorId: string,
        options: { agent?: string; json?: boolean },
      ) => {
        const agentId = resolveConnectorAgentId(options.agent);
        const [connector, agentCtx] = await Promise.all([
          getCustomConnector(connectorId),
          resolveCustomAgentContext(agentId),
        ]);
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                context: "current",
                target: { kind: "custom", customConnectorId: connectorId },
                state: connector === null ? "unavailable" : "available",
                agent: agentCtx
                  ? {
                      agentId: agentCtx.agentId,
                      displayName: agentCtx.displayName,
                    }
                  : null,
                connector:
                  connector === null
                    ? null
                    : customConnectorJson(connector, agentCtx),
              },
              null,
              2,
            ),
          );
          if (connector === null) {
            process.exitCode = 1;
          }
          return;
        }
        if (!connector) {
          throw new Error(`Custom connector not found: ${connectorId}`);
        }
        console.log(`Custom connector: ${chalk.cyan(connector.displayName)}`);
        console.log();
        console.log(`${"ID:".padEnd(LABEL_WIDTH)}${connector.id}`);
        console.log(`${"Kind:".padEnd(LABEL_WIDTH)}${connector.kind}`);
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${renderConnected(connector)}`,
        );
        if (connector.kind === "mcp") {
          console.log(
            `${"Transport:".padEnd(LABEL_WIDTH)}${connector.transport}`,
          );
          console.log(
            `${"Endpoint:".padEnd(LABEL_WIDTH)}${connector.endpoint}`,
          );
        } else {
          console.log(
            `${"Prefixes:".padEnd(LABEL_WIDTH)}${connector.prefixTemplates.join(", ")}`,
          );
        }
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
  .description("Create, update, and inspect org custom connectors")
  .addCommand(createCustomConnectorCommand)
  .addCommand(updateCustomConnectorCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addHelpText(
    "after",
    `
To add a custom connector:
  Run "okou connector custom create -h" and follow the definition-only creation workflow.`,
  );
