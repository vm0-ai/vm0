import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { apiClient } from "../lib/api-client";
import { validateAgentCompose } from "../lib/yaml-validator";

export const buildCommand = new Command()
  .name("build")
  .description("Create or update agent compose")
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

      // 3. Validate compose (no variable expansion - variables are expanded at run time)
      const validation = validateAgentCompose(config);
      if (!validation.valid) {
        console.error(chalk.red(`✗ ${validation.error}`));
        process.exit(1);
      }

      // 4. Call API
      console.log(chalk.blue("Uploading compose..."));

      const response = await apiClient.createOrUpdateCompose({
        content: config,
      });

      // 5. Display result
      const shortVersionId = response.versionId.slice(0, 8);
      if (response.action === "created") {
        console.log(chalk.green(`✓ Compose created: ${response.name}`));
      } else {
        console.log(chalk.green(`✓ Compose version exists: ${response.name}`));
      }

      console.log(chalk.gray(`  Compose ID: ${response.composeId}`));
      console.log(chalk.gray(`  Version:    ${shortVersionId}`));
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
        } else if (error.message.includes("Failed to create compose")) {
          console.error(chalk.red("✗ Failed to create compose"));
          console.error(chalk.gray(`  ${error.message}`));
        } else {
          console.error(chalk.red("✗ Failed to create compose"));
          console.error(chalk.gray(`  ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
