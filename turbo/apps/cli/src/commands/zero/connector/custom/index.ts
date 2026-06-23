import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { customConnectorProposalSchema } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  getZeroAgent,
  getZeroAgentCustomConnectors,
  getZeroCustomConnector,
  listZeroCustomConnectors,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { getPlatformOrigin } from "../../doctor/platform-url";

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

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

const proposeCommand = new Command()
  .name("propose")
  .description("Create a browser save link for a custom connector proposal")
  .requiredOption("--proposal-file <path>", "JSON proposal file")
  .option("--connector-id <id>", "Override connector id for update proposals")
  .option("--agent <id>", "Authorize this agent when the proposal is saved")
  .action(
    withErrorHandler(
      async (options: {
        proposalFile: string;
        connectorId?: string;
        agent?: string;
      }) => {
        const raw = await readFile(options.proposalFile, "utf8");
        const proposalJson: unknown = JSON.parse(raw);
        if (!isJsonObject(proposalJson)) {
          throw new Error("Proposal file must contain a JSON object");
        }
        const parsed = customConnectorProposalSchema.parse({
          ...proposalJson,
          ...(options.connectorId ? { connectorId: options.connectorId } : {}),
        });
        const origin = await getPlatformOrigin();
        const params = new URLSearchParams({
          p: encodeBase64UrlJson(parsed),
        });
        const agentId = options.agent ?? process.env.ZERO_AGENT_ID;
        if (agentId) {
          params.set("agentId", agentId);
        }
        const url = `${origin}/connectors/custom/proposal?${params.toString()}`;
        console.log(`[Configure ${parsed.displayName}](${url})`);
        console.log();
        console.log(
          "Open this link to review, save values, and authorize the connector.",
        );
      },
    ),
  );

export const customConnectorCommand = new Command()
  .name("custom")
  .description("Inspect and propose org custom connectors")
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(proposeCommand);
