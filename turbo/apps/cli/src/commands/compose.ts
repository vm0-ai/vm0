import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { parse as parseYaml } from "yaml";
import { apiClient } from "../lib/api-client";
import { validateAgentCompose } from "../lib/yaml-validator";
import { getProviderDefaults } from "../lib/provider-config";
import { uploadSystemPrompt, uploadSystemSkill } from "../lib/system-storage";

export const composeCommand = new Command()
  .name("compose")
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

      // 4. Process system_prompt and system_skills
      const cfg = config as Record<string, unknown>;
      const agents = cfg.agents as Record<string, Record<string, unknown>>;
      const agentName = Object.keys(agents)[0]!;
      const agent = agents[agentName]!;
      const basePath = dirname(configFile);

      // Apply provider auto-configuration if not explicitly set
      if (agent.provider) {
        const defaults = getProviderDefaults(agent.provider as string);
        if (defaults) {
          if (!agent.image) {
            agent.image = defaults.image;
            console.log(
              chalk.gray(`  Auto-configured image: ${defaults.image}`),
            );
          }
          if (!agent.working_dir) {
            agent.working_dir = defaults.workingDir;
            console.log(
              chalk.gray(
                `  Auto-configured working_dir: ${defaults.workingDir}`,
              ),
            );
          }
        }
      }

      // Upload system_prompt if specified
      if (agent.system_prompt) {
        const promptPath = agent.system_prompt as string;
        console.log(chalk.blue(`Uploading system prompt: ${promptPath}`));
        try {
          const result = await uploadSystemPrompt(
            agentName,
            promptPath,
            basePath,
          );
          console.log(
            chalk.green(
              `✓ System prompt ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.versionId.slice(0, 8)}`,
            ),
          );
        } catch (error) {
          console.error(chalk.red(`✗ Failed to upload system prompt`));
          if (error instanceof Error) {
            console.error(chalk.gray(`  ${error.message}`));
          }
          process.exit(1);
        }
      }

      // Upload system_skills if specified
      if (agent.system_skills && Array.isArray(agent.system_skills)) {
        const skillUrls = agent.system_skills as string[];
        console.log(
          chalk.blue(`Uploading ${skillUrls.length} system skill(s)...`),
        );
        for (const skillUrl of skillUrls) {
          try {
            console.log(chalk.gray(`  Downloading: ${skillUrl}`));
            const result = await uploadSystemSkill(skillUrl);
            console.log(
              chalk.green(
                `  ✓ Skill ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.versionId.slice(0, 8)}`,
              ),
            );
          } catch (error) {
            console.error(chalk.red(`✗ Failed to upload skill: ${skillUrl}`));
            if (error instanceof Error) {
              console.error(chalk.gray(`  ${error.message}`));
            }
            process.exit(1);
          }
        }
      }

      // 5. Call API
      console.log(chalk.blue("Uploading compose..."));

      const response = await apiClient.createOrUpdateCompose({
        content: config,
      });

      // 6. Display result
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
