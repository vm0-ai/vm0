import { Command, Option } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { parse as parseYaml } from "yaml";
import {
  getLegacySystemTemplateWarning,
  extractVariableReferences,
  groupVariablesBySource,
} from "@vm0/core";
import {
  getComposeByName,
  createOrUpdateCompose,
  getScope,
} from "../../lib/api";
import { validateAgentCompose } from "../../lib/domain/yaml-validator";
import {
  uploadInstructions,
  uploadSkill,
  type SkillUploadResult,
} from "../../lib/storage/system-storage";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { silentUpgradeAfterCommand } from "../../lib/utils/update-checker";

declare const __CLI_VERSION__: string;

/**
 * Extract secret names from compose content using variable references.
 * Looks for ${{ secrets.XXX }} patterns in the compose.
 */
export function getSecretsFromComposeContent(content: unknown): Set<string> {
  const refs = extractVariableReferences(content);
  const grouped = groupVariablesBySource(refs);
  return new Set(grouped.secrets.map((r) => r.name));
}

interface AgentConfig {
  instructions?: string;
  framework?: string;
  skills?: string[];
  environment?: Record<string, string>;
}

interface LoadedConfig {
  config: unknown;
  agentName: string;
  agent: AgentConfig;
  basePath: string;
}

/**
 * Load and validate the compose config file.
 * Returns parsed config with agent info or exits on error.
 */
async function loadAndValidateConfig(
  configFile: string,
): Promise<LoadedConfig> {
  if (!existsSync(configFile)) {
    console.error(chalk.red(`✗ Config file not found: ${configFile}`));
    process.exit(1);
  }

  const content = await readFile(configFile, "utf8");

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

  const validation = validateAgentCompose(config);
  if (!validation.valid) {
    console.error(chalk.red(`✗ ${validation.error}`));
    process.exit(1);
  }

  const cfg = config as Record<string, unknown>;
  const agentsConfig = cfg.agents as Record<string, Record<string, unknown>>;
  const agentName = Object.keys(agentsConfig)[0]!;
  const agent = agentsConfig[agentName] as AgentConfig;
  const basePath = dirname(configFile);

  return { config, agentName, agent, basePath };
}

/**
 * Check for legacy image format and show deprecation warnings.
 */
function checkLegacyImageFormat(config: unknown): void {
  const cfg = config as Record<string, unknown>;
  const agentsConfig = cfg.agents as Record<string, Record<string, unknown>>;

  for (const [name, agentConfig] of Object.entries(agentsConfig)) {
    const image = agentConfig.image as string | undefined;
    if (image) {
      console.log(
        chalk.yellow(
          `⚠ Agent "${name}": 'image' field is deprecated. Use 'apps' field for pre-installed tools.`,
        ),
      );
      const warning = getLegacySystemTemplateWarning(image);
      if (warning) {
        console.log(chalk.yellow(`  ${warning}`));
      }
    }
  }
}

/**
 * Upload instructions and skills, returning skill results.
 */
async function uploadAssets(
  agentName: string,
  agent: AgentConfig,
  basePath: string,
): Promise<SkillUploadResult[]> {
  if (agent.instructions) {
    console.log(`Uploading instructions: ${agent.instructions}`);
    const result = await uploadInstructions(
      agentName,
      agent.instructions,
      basePath,
      agent.framework,
    );
    console.log(
      chalk.green(
        `✓ Instructions ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.versionId.slice(0, 8)}`,
      ),
    );
  }

  const skillResults: SkillUploadResult[] = [];
  if (agent.skills && Array.isArray(agent.skills)) {
    console.log(`Uploading ${agent.skills.length} skill(s)...`);
    for (const skillUrl of agent.skills) {
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

  return skillResults;
}

interface SkillVariables {
  newSecrets: Array<[string, string[]]>;
  newVars: Array<[string, string[]]>;
  trulyNewSecrets: string[];
}

/**
 * Collect secrets and vars from skill frontmatters.
 */
async function collectSkillVariables(
  skillResults: SkillUploadResult[],
  environment: Record<string, string>,
  agentName: string,
): Promise<SkillVariables> {
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

  const newSecrets = [...skillSecrets.entries()].filter(
    ([name]) => !(name in environment),
  );
  const newVars = [...skillVars.entries()].filter(
    ([name]) => !(name in environment),
  );

  // Fetch HEAD version to compare secrets
  let headSecrets = new Set<string>();
  const existingCompose = await getComposeByName(agentName);
  if (existingCompose?.content) {
    headSecrets = getSecretsFromComposeContent(existingCompose.content);
  }

  const trulyNewSecrets = newSecrets
    .map(([name]) => name)
    .filter((name) => !headSecrets.has(name));

  return { newSecrets, newVars, trulyNewSecrets };
}

/**
 * Display skill variables and confirm new secrets with user.
 * Returns false if user cancels, true otherwise.
 */
async function displayAndConfirmVariables(
  variables: SkillVariables,
  options: { yes?: boolean },
): Promise<boolean> {
  const { newSecrets, newVars, trulyNewSecrets } = variables;

  if (newSecrets.length === 0 && newVars.length === 0) {
    return true;
  }

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
      console.log(`    ${name.padEnd(24)}${newMarker} <- ${skills.join(", ")}`);
    }
  }

  if (newVars.length > 0) {
    console.log(chalk.cyan("  Vars:"));
    for (const [name, skills] of newVars) {
      console.log(`    ${name.padEnd(24)} <- ${skills.join(", ")}`);
    }
  }

  console.log();

  if (trulyNewSecrets.length > 0 && !options.yes) {
    if (!isInteractive()) {
      console.error(
        chalk.red(`✗ New secrets detected: ${trulyNewSecrets.join(", ")}`),
      );
      console.error(
        chalk.dim(
          "  Use --yes flag to approve new secrets in non-interactive mode.",
        ),
      );
      process.exit(1);
    }

    const confirmed = await promptConfirm(
      `Approve ${trulyNewSecrets.length} new secret(s)?`,
      true,
    );
    if (!confirmed) {
      console.log(chalk.yellow("Compose cancelled"));
      return false;
    }
  }

  return true;
}

/**
 * Merge skill variables into environment config.
 */
function mergeSkillVariables(
  agent: AgentConfig,
  variables: SkillVariables,
): void {
  const { newSecrets, newVars } = variables;

  if (newSecrets.length === 0 && newVars.length === 0) {
    return;
  }

  const environment = agent.environment || {};

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

export const composeCommand = new Command()
  .name("compose")
  .description("Create or update agent compose (e.g., vm0.yaml)")
  .argument("<agent-yaml>", "Path to agent YAML file")
  .option("-y, --yes", "Skip confirmation prompts for skill requirements")
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
    async (
      configFile: string,
      options: { yes?: boolean; autoUpdate?: boolean },
    ) => {
      try {
        // 1. Load and validate config
        const { config, agentName, agent, basePath } =
          await loadAndValidateConfig(configFile);

        // 2. Check for legacy image format
        checkLegacyImageFormat(config);

        // 3. Upload instructions and skills
        const skillResults = await uploadAssets(agentName, agent, basePath);

        // 4. Collect and process skill variables
        const environment = agent.environment || {};
        const variables = await collectSkillVariables(
          skillResults,
          environment,
          agentName,
        );

        // 5. Display variables and confirm with user
        const confirmed = await displayAndConfirmVariables(variables, options);
        if (!confirmed) {
          process.exit(0);
        }

        // 6. Merge skill variables into environment
        mergeSkillVariables(agent, variables);

        // 7. Call API
        console.log("Uploading compose...");
        const response = await createOrUpdateCompose({ content: config });

        // 8. Display result
        const scopeResponse = await getScope();
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

        // Silent upgrade after successful command completion
        if (options.autoUpdate !== false) {
          await silentUpgradeAfterCommand(__CLI_VERSION__);
        }
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else {
            console.error(chalk.red("✗ Failed to create compose"));
            console.error(chalk.dim(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
