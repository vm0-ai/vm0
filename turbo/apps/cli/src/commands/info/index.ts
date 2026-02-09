import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "fs";
import { homedir, release, type } from "os";
import { join } from "path";
import { getApiUrl, loadConfig } from "../../lib/api/config";
import { detectPackageManager } from "../../lib/utils/update-checker";

declare const __CLI_VERSION__: string;

const CONFIG_PATH = join(homedir(), ".vm0", "config.json");

export const infoCommand = new Command()
  .name("info")
  .description("Display environment and debug information")
  .action(async () => {
    // CLI version header
    console.log(chalk.bold(`VM0 CLI v${__CLI_VERSION__}`));
    console.log();

    // Authentication section
    const config = await loadConfig();
    const hasEnvToken = !!process.env.VM0_TOKEN;
    const hasConfigToken = !!config.token;
    const isAuthenticated = hasEnvToken || hasConfigToken;

    console.log(chalk.bold("Authentication:"));
    if (isAuthenticated) {
      const tokenSource = hasEnvToken ? "VM0_TOKEN env var" : "config file";
      console.log(`  ${chalk.green("✓")} Logged in (via ${tokenSource})`);
    } else {
      console.log(`  ${chalk.red("✗")} Not authenticated`);
    }

    const configExists = existsSync(CONFIG_PATH);
    const configDisplay = configExists
      ? `~/.vm0/config.json`
      : `~/.vm0/config.json (not found)`;
    console.log(`  Config: ${configDisplay}`);
    console.log();

    // API section
    const apiUrl = await getApiUrl();
    console.log(chalk.bold("API:"));
    console.log(`  Host: ${apiUrl}`);
    console.log();

    // System section
    console.log(chalk.bold("System:"));
    console.log(`  Node: ${process.version}`);
    console.log(`  Platform: ${process.platform} (${process.arch})`);
    console.log(`  OS: ${type()} ${release()}`);
    console.log(`  Shell: ${process.env.SHELL ?? "unknown"}`);
    console.log(`  Package Manager: ${detectPackageManager()}`);
  });
