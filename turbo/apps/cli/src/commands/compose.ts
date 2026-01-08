import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { parse as parseYaml } from "yaml";
import prompts from "prompts";
import {
  getLegacySystemTemplateWarning,
  extractVariableReferences,
  groupVariablesBySource,
} from "@vm0/core";
import { apiClient } from "../lib/api-client";
import { validateAgentCompose } from "../lib/yaml-validator";
import {
  getProviderDefaults,
  getDefaultImageWithApps,
} from "../lib/provider-config";
import {
  uploadInstructions,
  uploadSkill,
  type SkillUploadResult,
} from "../lib/system-storage";

/**
 * Extract secret names from compose content using variable references.
 * Looks for ${{ secrets.XXX }} patterns in the compose.
 */
export function getSecretsFromComposeContent(content: unknown): Set<string> {
  const refs = extractVariableReferences(content);
  const grouped = groupVariablesBySource(refs);
  return new Set(grouped.secrets.map((r) => r.name));
}

/**
 * Transform experimental_secrets and experimental_vars shorthand to environment entries.
 * - experimental_secrets: ["KEY"] → environment: { KEY: "${{ secrets.KEY }}" }
 * - experimental_vars: ["KEY"] → environment: { KEY: "${{ vars.KEY }}" }
 * - Explicit environment entries take precedence over shorthand
 * - Shorthand fields are removed after transformation
 */
export function transformExperimentalShorthand(
  agent: Record<string, unknown>,
): void {
  const experimentalSecrets = agent.experimental_secrets as
    | string[]
    | undefined;
  const experimentalVars = agent.experimental_vars as string[] | undefined;

  if (!experimentalSecrets && !experimentalVars) {
    return;
  }

  // Initialize environment if not exists
  const environment = (agent.environment as Record<string, string>) || {};

  // Transform experimental_secrets
  if (experimentalSecrets) {
    for (const secretName of experimentalSecrets) {
      if (!(secretName in environment)) {
        environment[secretName] = "${{ secrets." + secretName + " }}";
      }
    }
    delete agent.experimental_secrets;
  }

  // Transform experimental_vars
  if (experimentalVars) {
    for (const varName of experimentalVars) {
      if (!(varName in environment)) {
        environment[varName] = "${{ vars." + varName + " }}";
      }
    }
    delete agent.experimental_vars;
  }

  // Only set environment if we added entries
  if (Object.keys(environment).length > 0) {
    agent.environment = environment;
  }
}

export const composeCommand = new Command()
  .name("compose")
  .description("Create or update agent compose")
  .argument("<config-file>", "Path to config YAML file")
  .option("-y, --yes", "Skip confirmation prompts for skill requirements")
  .action(async (configFile: string, options: { yes?: boolean }) => {
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

      // 3.5 Transform experimental shorthand to environment entries
      const cfg = config as Record<string, unknown>;
      const agentsConfig = cfg.agents as Record<
        string,
        Record<string, unknown>
      >;
      for (const agentConfig of Object.values(agentsConfig)) {
        transformExperimentalShorthand(agentConfig);
      }

      // 3.6 Check for legacy image format and show deprecation warnings
      for (const [name, agentConfig] of Object.entries(agentsConfig)) {
        const image = agentConfig.image as string | undefined;
        if (image) {
          // Show deprecation warning for explicit image field
          console.log(
            chalk.yellow(
              `⚠ Agent "${name}": 'image' field is deprecated. Use 'apps' field for pre-installed tools.`,
            ),
          );
          // Also check for legacy vm0-* format
          const warning = getLegacySystemTemplateWarning(image);
          if (warning) {
            console.log(chalk.yellow(`  ${warning}`));
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
            // Use apps-aware image selection
            const apps = agent.apps as string[] | undefined;
            const defaultImage = getDefaultImageWithApps(
              agent.provider as string,
              apps,
            );
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
      }

      // Upload skills if specified and collect their frontmatter
      const skillResults: SkillUploadResult[] = [];
      if (agent.skills && Array.isArray(agent.skills)) {
        const skillUrls = agent.skills as string[];
        console.log(`Uploading ${skillUrls.length} skill(s)...`);
        for (const skillUrl of skillUrls) {
          console.log(chalk.dim(`  Downloading: ${skillUrl}`));
          const result = await uploadSkill(skillUrl);
          skillResults.push(result);
          console.log(
            chalk.green(
              `  ✓ Skill ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.skillName} (${result.versionId.slice(0, 8)})`,
            ),
          );
        }
      }

      // Collect all secrets/vars from skill frontmatters
      // Map: varName -> array of skill names that declared it
      const skillSecrets = new Map<string, string[]>();
      const skillVars = new Map<string, string[]>();

      for (const result of skillResults) {
        const { frontmatter, skillName } = result;
        if (frontmatter.vm0_secrets) {
          for (const secret of frontmatter.vm0_secrets) {
            if (!skillSecrets.has(secret)) {
              skillSecrets.set(secret, []);
            }
            skillSecrets.get(secret)!.push(skillName);
          }
        }
        if (frontmatter.vm0_vars) {
          for (const varName of frontmatter.vm0_vars) {
            if (!skillVars.has(varName)) {
              skillVars.set(varName, []);
            }
            skillVars.get(varName)!.push(skillName);
          }
        }
      }

      // Filter out vars already in environment (explicit takes precedence)
      const environment = (agent.environment as Record<string, string>) || {};
      const newSecrets = [...skillSecrets.entries()].filter(
        ([name]) => !(name in environment),
      );
      const newVars = [...skillVars.entries()].filter(
        ([name]) => !(name in environment),
      );

      // Fetch HEAD version to compare secrets (for smart confirmation)
      let headSecrets = new Set<string>();
      try {
        const existingCompose = await apiClient.getComposeByName(agentName);
        if (existingCompose.content) {
          headSecrets = getSecretsFromComposeContent(existingCompose.content);
        }
      } catch {
        // No existing compose - all secrets are new (first-time compose)
      }

      // Determine truly new secrets (not in HEAD version)
      const trulyNewSecrets = newSecrets
        .map(([name]) => name)
        .filter((name) => !headSecrets.has(name));

      // If there are secrets or vars from skills, display them
      if (newSecrets.length > 0 || newVars.length > 0) {
        console.log();
        console.log(
          chalk.bold("Skills require the following environment variables:"),
        );
        console.log();

        if (newSecrets.length > 0) {
          console.log(chalk.cyan("  Secrets:"));
          for (const [name, skills] of newSecrets) {
            const isNew = trulyNewSecrets.includes(name);
            const newMarker = isNew ? chalk.yellow(" (new)") : "";
            console.log(
              `    ${name.padEnd(24)}${newMarker} <- ${skills.join(", ")}`,
            );
          }
        }

        if (newVars.length > 0) {
          console.log(chalk.cyan("  Vars:"));
          for (const [name, skills] of newVars) {
            console.log(`    ${name.padEnd(24)} <- ${skills.join(", ")}`);
          }
        }

        console.log();

        // Only require confirmation if there are TRULY NEW secrets
        if (trulyNewSecrets.length > 0) {
          if (!options.yes) {
            if (!process.stdin.isTTY) {
              console.error(
                chalk.red(
                  `✗ New secrets detected: ${trulyNewSecrets.join(", ")}`,
                ),
              );
              console.error(
                chalk.dim(
                  "  Use --yes flag to approve new secrets in non-interactive mode.",
                ),
              );
              process.exit(1);
            }

            const response = await prompts({
              type: "confirm",
              name: "value",
              message: `Approve ${trulyNewSecrets.length} new secret(s)?`,
              initial: true,
            });
            if (!response.value) {
              console.log(chalk.yellow("Compose cancelled."));
              process.exit(0);
            }
          }
        }

        // Merge skill vars into environment
        for (const [name] of newSecrets) {
          environment[name] = `\${{ secrets.${name} }}`;
        }
        for (const [name] of newVars) {
          environment[name] = `\${{ vars.${name} }}`;
        }

        if (Object.keys(environment).length > 0) {
          agent.environment = environment;
        }
      }

      // 5. Call API
      console.log("Uploading compose...");

      const response = await apiClient.createOrUpdateCompose({
        content: config,
      });

      // Get user's scope for display (must exist if compose succeeded)
      const scopeResponse = await apiClient.getScope();

      // 6. Display result
      const shortVersionId = response.versionId.slice(0, 8);
      const displayName = `${scopeResponse.slug}/${response.name}`;

      if (response.action === "created") {
        console.log(chalk.green(`✓ Compose created: ${displayName}`));
      } else {
        console.log(chalk.green(`✓ Compose version exists: ${displayName}`));
      }

      console.log(chalk.dim(`  Version: ${shortVersionId}`));
      console.log();
      console.log("  Run your agent:");
      console.log(
        chalk.cyan(
          `    vm0 run ${displayName}:${shortVersionId} --artifact-name <artifact> "your prompt"`,
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
