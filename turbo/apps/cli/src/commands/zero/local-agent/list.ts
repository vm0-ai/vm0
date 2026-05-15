import { Command } from "commander";
import chalk from "chalk";
import type { LocalAgentHost } from "@vm0/api-contracts/contracts/zero-local-agent";
import { listLocalAgentHosts } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

function formatAge(value: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function statusLabel(host: LocalAgentHost): string {
  if (host.status === "online") {
    return chalk.green("online");
  }
  return chalk.yellow("closed");
}

function printHosts(hosts: LocalAgentHost[]): void {
  if (hosts.length === 0) {
    console.log("No local-agent hosts found.");
    console.log(chalk.dim("  Run: vm0 local-agent start --name <name>"));
    return;
  }

  const rows = hosts.map((host) => {
    return {
      id: host.id,
      status: statusLabel(host),
      name: host.displayName,
      backends: host.supportedBackends.join(","),
      lastSeen: formatAge(host.lastSeenAt),
    };
  });

  const idWidth = Math.max(
    "HOST ID".length,
    ...rows.map((row) => {
      return row.id.length;
    }),
  );
  const statusWidth = "STATUS".length;
  const backendWidth = Math.max(
    "BACKENDS".length,
    ...rows.map((row) => {
      return row.backends.length;
    }),
  );
  const lastSeenWidth = Math.max(
    "LAST SEEN".length,
    ...rows.map((row) => {
      return row.lastSeen.length;
    }),
  );

  console.log(
    [
      "HOST ID".padEnd(idWidth),
      "STATUS".padEnd(statusWidth),
      "BACKENDS".padEnd(backendWidth),
      "LAST SEEN".padEnd(lastSeenWidth),
      "NAME",
    ].join("  "),
  );

  for (const row of rows) {
    console.log(
      [
        row.id.padEnd(idWidth),
        row.status.padEnd(statusWidth),
        row.backends.padEnd(backendWidth),
        row.lastSeen.padEnd(lastSeenWidth),
        row.name,
      ].join("  "),
    );
  }
}

export const listCommand = new Command()
  .name("list")
  .description("List local-agent hosts")
  .action(
    withErrorHandler(async () => {
      const result = await listLocalAgentHosts();
      printHosts(result.hosts);
    }),
  );
