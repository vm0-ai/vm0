import { Command } from "commander";
import chalk from "chalk";
import {
  detectPackageManager,
  getLatestVersion,
  getManualUpgradeCommand,
  isAutoUpgradeSupported,
  performUpgrade,
} from "../../lib/utils/update-checker";
import { withErrorHandler } from "../../lib/command";

declare const __CLI_VERSION__: string;

export const upgradeCommand = new Command()
  .name("upgrade")
  .description("Upgrade vm0 CLI to the latest version")
  .action(
    withErrorHandler(async () => {
      console.log("Checking for updates...");

      const latestVersion = await getLatestVersion();

      if (latestVersion === null) {
        throw new Error("Could not check for updates. Please try again later.");
      }

      if (latestVersion === __CLI_VERSION__) {
        console.log(chalk.green(`✓ Already up to date (${__CLI_VERSION__})`));
        return;
      }

      console.log(
        chalk.yellow(
          `Current version: ${__CLI_VERSION__} -> Latest version: ${latestVersion}`,
        ),
      );
      console.log();

      const packageManager = detectPackageManager();

      if (!isAutoUpgradeSupported(packageManager)) {
        if (packageManager === "unknown") {
          console.log(
            chalk.yellow(
              "Could not detect your package manager for auto-upgrade.",
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `Auto-upgrade is not supported for ${packageManager}.`,
            ),
          );
        }
        console.log(chalk.yellow("Please upgrade manually:"));
        console.log(chalk.cyan(`  ${getManualUpgradeCommand(packageManager)}`));
        return;
      }

      console.log(`Upgrading via ${packageManager}...`);
      const success = await performUpgrade(packageManager);

      if (success) {
        console.log(
          chalk.green(`✓ Upgraded from ${__CLI_VERSION__} to ${latestVersion}`),
        );
        return;
      }

      throw new Error("Upgrade failed", {
        cause: new Error(
          `Please run manually: ${getManualUpgradeCommand(packageManager)}`,
        ),
      });
    }),
  );
