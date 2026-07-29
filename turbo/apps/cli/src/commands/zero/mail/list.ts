import chalk from "chalk";
import { Command } from "commander";

import { listZeroConnectorCatalogStatus } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "../connector/agent-context";
import { findConnectorStatusItem } from "../connector/public-catalog";
import { MAIL_CONNECTOR_SLUG_BY_PROVIDER, currentAgentId } from "./shared";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List Gmail and Outlook Mail availability for the current agent")
  .action(
    withErrorHandler(async () => {
      const agentId = currentAgentId();
      const [{ connectors }, agent] = await Promise.all([
        listZeroConnectorCatalogStatus(),
        resolveAgentContext(agentId),
      ]);
      if (!agent) {
        throw new Error("Agent context could not be loaded");
      }

      const rows = Object.entries(MAIL_CONNECTOR_SLUG_BY_PROVIDER).map(
        ([provider, connectorSlug]) => {
          const connector = findConnectorStatusItem(connectors, connectorSlug);
          const authorized = agent.authorizedConnectorSlugs.has(connectorSlug);
          const ready =
            authorized &&
            connector?.connected === true &&
            connector.connectionStatus === "connected";
          const sender = authorized
            ? (connector?.connection?.externalEmail ?? "-")
            : "-";
          const status = ready
            ? chalk.green("ready")
            : connector?.connectionStatus === "reconnect-required" ||
                connector?.connectionStatus === "scope-mismatch"
              ? chalk.yellow("reconnect")
              : connector?.connected
                ? chalk.yellow("authorize")
                : chalk.dim("connect");
          return { provider, sender, status };
        },
      );

      const providerWidth = Math.max(
        "PROVIDER".length,
        ...rows.map((row) => {
          return row.provider.length;
        }),
      );
      const senderWidth = Math.max(
        "SENDER".length,
        ...rows.map((row) => {
          return row.sender.length;
        }),
      );
      console.log(
        chalk.dim(
          [
            "PROVIDER".padEnd(providerWidth),
            "SENDER".padEnd(senderWidth),
            "STATUS",
          ].join("  "),
        ),
      );
      for (const row of rows) {
        console.log(
          [
            row.provider.padEnd(providerWidth),
            row.sender.padEnd(senderWidth),
            row.status,
          ].join("  "),
        );
      }
      console.log();
      console.log(
        chalk.dim("  Run: zero mail connect gmail|outlook when needed"),
      );
    }),
  );
