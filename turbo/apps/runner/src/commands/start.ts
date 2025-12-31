import { Command } from "commander";
import { loadConfig, validateFirecrackerPaths } from "../lib/config.js";

export const startCommand = new Command("start")
  .description("Start the runner")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .option("--api-url <url>", "VM0 API URL")
  .option("--dry-run", "Validate config without starting")
  .action((options: { config: string; apiUrl?: string; dryRun?: boolean }) => {
    try {
      // Load and validate config
      const config = loadConfig(options.config);

      // Validate firecracker paths exist
      validateFirecrackerPaths(config.firecracker);

      console.log("Config valid");

      if (options.dryRun) {
        console.log(JSON.stringify(config, null, 2));
        process.exit(0);
      }

      // TODO: Phase 2+ - Start polling loop
      console.log("Runner start not yet implemented");
      console.log(`Would connect to: ${options.apiUrl || "default API"}`);
      console.log(`Runner name: ${config.name}`);
      console.log(`Runner group: ${config.group}`);
      process.exit(0);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unknown error occurred");
      }
      process.exit(1);
    }
  });
