import { Command } from "commander";
import chalk from "chalk";
import { getRunQueue } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils/file-utils";
import { withErrorHandler } from "../../lib/command";

export const queueCommand = new Command()
  .name("queue")
  .description("Show org run queue status")
  .action(
    withErrorHandler(async () => {
      const data = await getRunQueue();
      const { concurrency, queue } = data;

      // Concurrency header
      const limitDisplay =
        concurrency.limit === 0
          ? "unlimited"
          : `${concurrency.active}/${concurrency.limit} slots used`;
      console.log(`Concurrency: ${limitDisplay} (${concurrency.tier} tier)`);

      // Queue status
      if (queue.length === 0) {
        console.log(chalk.dim("Queue: empty — all slots available"));
        return;
      }

      console.log(
        `Queue: ${queue.length} run${queue.length > 1 ? "s" : ""} waiting`,
      );
      console.log();

      // Dynamic column widths
      const posWidth = Math.max(1, String(queue.length).length);
      const agentWidth = Math.max(5, ...queue.map((e) => e.agentName.length));
      const emailWidth = Math.max(4, ...queue.map((e) => e.userEmail.length));

      // Header
      const header = [
        "#".padEnd(posWidth),
        "AGENT".padEnd(agentWidth),
        "USER".padEnd(emailWidth),
        "CREATED",
      ].join("  ");
      console.log(chalk.dim(header));

      // Rows
      for (const entry of queue) {
        const marker = entry.isOwner ? chalk.cyan("  ← you") : "";
        const row = [
          String(entry.position).padEnd(posWidth),
          entry.agentName.padEnd(agentWidth),
          entry.userEmail.padEnd(emailWidth),
          formatRelativeTime(entry.createdAt),
        ].join("  ");
        console.log(row + marker);
      }
    }),
  );
