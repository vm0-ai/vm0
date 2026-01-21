import { Command } from "commander";
import chalk from "chalk";
import { listStorages } from "../../lib/api";
import { formatBytes, formatRelativeTime } from "../../lib/utils/file-utils";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all remote volumes")
  .action(async () => {
    try {
      // Call API
      const items = await listStorages({ type: "volume" });

      if (items.length === 0) {
        console.log(chalk.dim("No volumes found"));
        console.log(
          chalk.dim("  Create one with: vm0 volume init && vm0 volume push"),
        );
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
      const sizeWidth = Math.max(
        4,
        ...items.map((i) => formatBytes(i.size).length),
      );
      const filesWidth = Math.max(
        5,
        ...items.map((i) => i.fileCount.toString().length),
      );

      // Print header
      const header = [
        "NAME".padEnd(nameWidth),
        "SIZE".padStart(sizeWidth),
        "FILES".padStart(filesWidth),
        "UPDATED",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const item of items) {
        const row = [
          item.name.padEnd(nameWidth),
          formatBytes(item.size).padStart(sizeWidth),
          item.fileCount.toString().padStart(filesWidth),
          formatRelativeTime(item.updatedAt),
        ].join("  ");
        console.log(row);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list volumes"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
