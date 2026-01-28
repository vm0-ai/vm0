import { Command } from "commander";
import { dirname, join } from "path";
import { loadConfig, validateFirecrackerPaths } from "../lib/config.js";
import { Runner } from "../lib/runner/index.js";

export const startCommand = new Command("start")
  .description("Start the runner")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(async (options: { config: string }): Promise<void> => {
    try {
      const config = loadConfig(options.config);
      validateFirecrackerPaths(config.firecracker);
      console.log("Config valid");

      const statusFilePath = join(dirname(options.config), "status.json");
      const runner = new Runner(config, statusFilePath);
      await runner.start();
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unknown error occurred");
      }
      process.exit(1);
    }
  });
