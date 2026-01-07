import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { pollForJob } from "../lib/api.js";

export const statusCommand = new Command("status")
  .description("Check runner connectivity to API")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(async (options: { config: string }): Promise<void> => {
    try {
      const config = loadConfig(options.config);

      console.log(`Checking connectivity to ${config.server.url}...`);
      console.log(`Runner group: ${config.group}`);

      // Make a test poll request to verify connectivity and authentication
      await pollForJob(config.server, config.group);

      console.log("");
      console.log("✓ Runner can connect to API");
      console.log(`  API: ${config.server.url}`);
      console.log(`  Group: ${config.group}`);
      console.log(`  Auth: OK`);
      process.exit(0);
    } catch (error) {
      console.error("");
      console.error("✗ Runner cannot connect to API");
      console.error(
        `  Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      process.exit(1);
    }
  });
