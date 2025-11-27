import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { apiClient } from "../lib/api-client";
import { validateAgentConfig } from "../lib/yaml-validator";
import {
  expandEnvVarsInObject,
  extractEnvVarReferences,
  validateEnvVars,
} from "../lib/env-expander";

export const buildCommand = new Command()
  .name("build")
  .description("Create or update agent configuration")
  .argument("<config-file>", "Path to config YAML file")
  .action(async (configFile: string) => {
    try {
      // 1. Read file
      if (!existsSync(configFile)) {
        console.error(chalk.red(`✗ Config file not found: ${configFile}`));
        process.exit(1);
      }

      const content = await readFile(configFile, "utf8");

      // 2. Parse YAML
      let config: unknown;
      try {
        config = parseYaml(content);
      } catch (error) {
        console.error(chalk.red("✗ Invalid YAML format"));
        if (error instanceof Error) {
          console.error(chalk.gray(`  ${error.message}`));
        }
        process.exit(1);
      }

      // 3. Validate environment variables before expansion
      const referencedVars = extractEnvVarReferences(config);
      const missingVars = validateEnvVars(referencedVars);

      if (missingVars.length > 0) {
        console.error(chalk.red("✗ Missing required environment variables:"));
        for (const varName of missingVars) {
          console.error(chalk.red(`  - ${varName}`));
        }
        console.error();
        console.error(
          chalk.gray("Please set these variables before running 'vm0 build'."),
        );
        console.error(chalk.gray("Example:"));
        for (const varName of missingVars) {
          console.error(chalk.gray(`  export ${varName}=your-value`));
        }
        process.exit(1);
      }

      // 4. Expand environment variables
      config = expandEnvVarsInObject(config);

      // 5. Validate config
      const validation = validateAgentConfig(config);
      if (!validation.valid) {
        console.error(chalk.red(`✗ ${validation.error}`));
        process.exit(1);
      }

      // 6. Call API
      console.log(chalk.blue("Uploading configuration..."));

      const response = await apiClient.createOrUpdateConfig({ config });

      // 7. Display result
      if (response.action === "created") {
        console.log(chalk.green(`✓ Config created: ${response.name}`));
      } else {
        console.log(chalk.green(`✓ Config updated: ${response.name}`));
      }

      console.log(chalk.gray(`  Config ID: ${response.configId}`));
      console.log();
      console.log("  Run your agent:");
      console.log(
        chalk.cyan(
          `    vm0 run ${response.name} --artifact-name <artifact> "your prompt"`,
        ),
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (error.message.includes("Failed to create config")) {
          console.error(chalk.red("✗ Failed to create config"));
          console.error(chalk.gray(`  ${error.message}`));
        } else {
          console.error(chalk.red("✗ Failed to create config"));
          console.error(chalk.gray(`  ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
