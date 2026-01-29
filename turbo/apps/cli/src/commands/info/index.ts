import { Command } from "commander";
import chalk from "chalk";
import { getApiUrl } from "../../lib/api/config";

export const infoCommand = new Command()
  .name("info")
  .description("Display environment information")
  .action(async () => {
    console.log(chalk.bold("System Information:"));
    console.log(`Node Version: ${process.version}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Architecture: ${process.arch}`);
    const apiUrl = await getApiUrl();
    console.log(`API Host: ${apiUrl}`);
  });
