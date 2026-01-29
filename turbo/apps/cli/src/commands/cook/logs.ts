import { Command } from "commander";
import chalk from "chalk";
import { loadCookState } from "../../lib/domain/cook-state";
import { printCommand, execVm0Command } from "./utils";

export const logsCommand = new Command()
  .name("logs")
  .description("View logs from the last cook run")
  .option("-a, --agent", "Show agent events (default)")
  .option("-s, --system", "Show system log")
  .option("-m, --metrics", "Show metrics")
  .option("-n, --network", "Show network logs (proxy traffic)")
  .option(
    "--since <time>",
    "Show logs since timestamp (e.g., 5m, 2h, 1d, 2024-01-15T10:30:00Z)",
  )
  .option("--tail <n>", "Show last N entries (default: 5, max: 100)")
  .option("--head <n>", "Show first N entries (max: 100)")
  .action(
    async (options: {
      agent?: boolean;
      system?: boolean;
      metrics?: boolean;
      network?: boolean;
      since?: string;
      tail?: string;
      head?: string;
    }) => {
      const state = await loadCookState();
      if (!state.lastRunId) {
        console.error(chalk.red("✗ No previous run found"));
        console.error(chalk.dim("  Run 'vm0 cook <prompt>' first"));
        process.exit(1);
      }

      // Build command args
      const args = ["logs", state.lastRunId];
      const displayArgs = [`vm0 logs ${state.lastRunId}`];

      if (options.agent) {
        args.push("--agent");
        displayArgs.push("--agent");
      }
      if (options.system) {
        args.push("--system");
        displayArgs.push("--system");
      }
      if (options.metrics) {
        args.push("--metrics");
        displayArgs.push("--metrics");
      }
      if (options.network) {
        args.push("--network");
        displayArgs.push("--network");
      }
      if (options.since) {
        args.push("--since", options.since);
        displayArgs.push(`--since ${options.since}`);
      }
      if (options.tail) {
        args.push("--tail", options.tail);
        displayArgs.push(`--tail ${options.tail}`);
      }
      if (options.head) {
        args.push("--head", options.head);
        displayArgs.push(`--head ${options.head}`);
      }

      printCommand(displayArgs.join(" "));
      await execVm0Command(args);
    },
  );
