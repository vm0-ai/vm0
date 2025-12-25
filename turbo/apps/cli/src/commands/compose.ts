import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { parse as parseYaml } from "yaml";
import { getLegacySystemTemplateWarning } from "@vm0/core";
import { apiClient } from "../lib/api-client";
import { validateAgentCompose } from "../lib/yaml-validator";
import { getProviderDefaults, getDefaultImage } from "../lib/provider-config";
import { uploadInstructions, uploadSkill } from "../lib/system-storage";

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
          console.error(chalk.dim(`  ${error.message}`));
        }
        process.exit(1);
      }

      // 3. Validate compose (no variable expansion - variables are expanded at run time)
      const validation = validateAgentCompose(config);
      if (!validation.valid) {
        console.error(chalk.red(`✗ ${validation.error}`));
        process.exit(1);
      }

      // 3.5 Check for legacy image format and show deprecation warning
      const cfg = config as Record<string, unknown>;
      const agentsConfig = cfg.agents as Record<
        string,
        Record<string, unknown>
      >;
      for (const [name, agentConfig] of Object.entries(agentsConfig)) {
        const image = agentConfig.image as string | undefined;
        if (image) {
          const warning = getLegacySystemTemplateWarning(image);
          if (warning) {
            console.log(chalk.yellow(`⚠ Agent "${name}": ${warning}`));
          }
        }
      }

      // 4. Process beta_system_prompt and beta_system_skills
      const agents = agentsConfig;
      const agentName = Object.keys(agents)[0]!;
      const agent = agents[agentName]!;
      const basePath = dirname(configFile);

      // Apply provider auto-configuration for image and working_dir if not explicitly set
      if (agent.provider) {
        const defaults = getProviderDefaults(agent.provider as string);
        if (defaults) {
          if (!agent.image) {
            const defaultImage = getDefaultImage(agent.provider as string);
            if (defaultImage) {
              agent.image = defaultImage;
              console.log(
                chalk.dim(`  Auto-configured image: ${defaultImage}`),
              );
            }
          }
          if (!agent.working_dir) {
            agent.working_dir = defaults.workingDir;
            console.log(
              chalk.dim(
                `  Auto-configured working_dir: ${defaults.workingDir}`,
              ),
            );
          }
        }
      }

      // Upload instructions if specified
      if (agent.instructions) {
        const instructionsPath = agent.instructions as string;
        const provider = agent.provider as string | undefined;
        console.log(`Uploading instructions: ${instructionsPath}`);
        try {
          const result = await uploadInstructions(
            agentName,
            instructionsPath,
            basePath,
            provider,
          );
          console.log(
            chalk.green(
              `✓ Instructions ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.versionId.slice(0, 8)}`,
            ),
          );
        } catch (error) {
          console.error(chalk.red(`✗ Failed to upload instructions`));
          if (error instanceof Error) {
            console.error(chalk.dim(`  ${error.message}`));
          }
          process.exit(1);
        }
      }

      // Upload skills if specified
      if (agent.skills && Array.isArray(agent.skills)) {
        const skillUrls = agent.skills as string[];
        console.log(`Uploading ${skillUrls.length} skill(s)...`);
        for (const skillUrl of skillUrls) {
          try {
            console.log(chalk.dim(`  Downloading: ${skillUrl}`));
            const result = await uploadSkill(skillUrl);
            console.log(
              chalk.green(
                `  ✓ Skill ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.versionId.slice(0, 8)}`,
              ),
            );
          } catch (error) {
            console.error(chalk.red(`✗ Failed to upload skill: ${skillUrl}`));
            if (error instanceof Error) {
              console.error(chalk.dim(`  ${error.message}`));
            }
            process.exit(1);
          }
        }
      }

      // 5. Call API
      console.log("Uploading compose...");

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

      console.log(chalk.dim(`  Compose ID: ${response.composeId}`));
      console.log(chalk.dim(`  Version:    ${shortVersionId}`));
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
          console.error(chalk.dim(`  ${error.message}`));
        } else {
          console.error(chalk.red("✗ Failed to create compose"));
          console.error(chalk.dim(`  ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
