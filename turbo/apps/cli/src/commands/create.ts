import chalk from "chalk";
import { APIClient, getAPIConfig } from "../lib/api-client";
import { loadConfig } from "../lib/config-loader";
import { validateConfig } from "../lib/config-validator";
import { success, error as outputError, info } from "../lib/output";

export async function createCommand(
  configPath: string,
  options: { json?: boolean },
): Promise<void> {
  try {
    // 1. Load config file
    if (!options.json) info(`Loading config from ${configPath}...`);
    const config = await loadConfig(configPath);
    if (!options.json) success("Config file loaded");

    // 2. Validate config
    if (!options.json) info("Validating config...");
    validateConfig(config);
    if (!options.json) success("Validation passed");

    // 3. Get API config
    const apiConfig = getAPIConfig();

    // 4. Create agent config via API
    if (!options.json) info("Creating agent config...");
    const client = new APIClient(apiConfig);
    const result = await client.createAgentConfig(config);
    if (!options.json) success("Agent config created successfully");

    // 5. Output result
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log();
      console.log(
        chalk.bold("Agent Config ID:"),
        chalk.cyan(result.agentConfigId),
      );
      console.log();
      console.log(chalk.gray("Next steps:"));
      console.log(chalk.gray("  Use this config ID to run your agent:"));
      console.log();
      console.log(
        chalk.gray(`  vm0 run ${result.agentConfigId} "your prompt here"`),
      );
      console.log();
    }
  } catch (err) {
    outputError(err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  }
}
