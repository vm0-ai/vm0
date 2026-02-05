import { Command, Option } from "commander";
import chalk from "chalk";
import { readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
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
import { downloadGitHubDirectory } from "../../lib/domain/github-skills";
import {
  uploadInstructions,
  uploadSkill,
  type SkillUploadResult,
} from "../../lib/storage/system-storage";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { silentUpgradeAfterCommand } from "../../lib/utils/update-checker";

declare const __CLI_VERSION__: string;

const DEFAULT_CONFIG_FILE = "vm0.yaml";

/**
 * Check if input is a GitHub URL (supports plain repo, root with branch, and subdirectory)
 * Matches: https://github.com/owner/repo[/tree/branch[/path]]
 */
function isGitHubUrl(input: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(input);
}

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
 * Type guard to check if config has a non-empty volumes field.
 */
function hasVolumes(config: unknown): boolean {
  if (typeof config !== "object" || config === null) {
    return false;
  }
  const cfg = config as Record<string, unknown>;
  const volumes = cfg.volumes;
  return (
    typeof volumes === "object" &&
    volumes !== null &&
    Object.keys(volumes).length > 0
  );
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

/**
 * Finalize compose: confirm variables, merge into config, call API, and display result.
 * Shared by both GitHub URL and local file flows.
 */
async function finalizeCompose(
  config: unknown,
  agent: AgentConfig,
  variables: SkillVariables,
  options: { yes?: boolean; autoUpdate?: boolean },
): Promise<void> {
  // Display variables and confirm with user
  const confirmed = await displayAndConfirmVariables(variables, options);
  if (!confirmed) {
    process.exit(0);
  }

  // Merge skill variables into environment
  mergeSkillVariables(agent, variables);

  // Call API
  console.log("Uploading compose...");
  const response = await createOrUpdateCompose({ content: config });

  // Display result
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
}

/**
 * Handle compose from GitHub URL
 */
async function handleGitHubCompose(
  url: string,
  options: { yes?: boolean; autoUpdate?: boolean },
): Promise<void> {
  console.log(`Downloading from GitHub: ${url}`);

  const { dir: downloadedDir, tempRoot } = await downloadGitHubDirectory(url);
  const configFile = join(downloadedDir, "vm0.yaml");

  try {
    if (!existsSync(configFile)) {
      console.error(chalk.red(`✗ vm0.yaml not found in the GitHub directory`));
      console.error(chalk.dim(`  URL: ${url}`));
      process.exit(1);
    }

    // Load and validate config
    const { config, agentName, agent, basePath } =
      await loadAndValidateConfig(configFile);

    // Check if agent with same name already exists
    const existingCompose = await getComposeByName(agentName);
    if (existingCompose) {
      console.log();
      console.log(
        chalk.yellow(`⚠ An agent named "${agentName}" already exists.`),
      );

      if (!isInteractive()) {
        // Non-interactive mode: require --yes flag to overwrite
        if (!options.yes) {
          console.error(
            chalk.red(
              `✗ Cannot overwrite existing agent in non-interactive mode`,
            ),
          );
          console.error(
            chalk.dim(
              `  Use --yes flag to confirm overwriting the existing agent.`,
            ),
          );
          process.exit(1);
        }
      } else {
        // Interactive mode: prompt user (default No)
        const confirmed = await promptConfirm(
          "Do you want to overwrite it?",
          false,
        );
        if (!confirmed) {
          console.log(chalk.yellow("Compose cancelled."));
          process.exit(0);
        }
      }
    }

    // Check for unsupported volumes
    if (hasVolumes(config)) {
      console.error(
        chalk.red(`✗ Volumes are not supported for GitHub URL compose`),
      );
      console.error(
        chalk.dim(
          `  Clone the repository locally and run: vm0 compose ./path/to/vm0.yaml`,
        ),
      );
      process.exit(1);
    }

    // Check for legacy image format
    checkLegacyImageFormat(config);

    // Upload instructions and skills
    const skillResults = await uploadAssets(agentName, agent, basePath);

    // Collect and process skill variables
    const environment = agent.environment || {};
    const variables = await collectSkillVariables(
      skillResults,
      environment,
      agentName,
    );

    // Finalize compose (confirm, merge, upload, display)
    await finalizeCompose(config, agent, variables, options);
  } finally {
    // Cleanup temp directory
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export const composeCommand = new Command()
  .name("compose")
  .description("Create or update agent compose (e.g., vm0.yaml)")
  .argument(
    "[agent-yaml]",
    `Path to agent YAML file or GitHub tree URL (default: ${DEFAULT_CONFIG_FILE})`,
  )
  .option("-y, --yes", "Skip confirmation prompts for skill requirements")
  .option(
    "--experimental-shared-compose",
    "Enable GitHub URL compose (experimental)",
  )
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
    async (
      configFile: string | undefined,
      options: {
        yes?: boolean;
        autoUpdate?: boolean;
        experimentalSharedCompose?: boolean;
      },
    ) => {
      const resolvedConfigFile = configFile ?? DEFAULT_CONFIG_FILE;
      try {
        // Branch based on input type
        if (isGitHubUrl(resolvedConfigFile)) {
          // Require experimental flag for GitHub URLs
          if (!options.experimentalSharedCompose) {
            console.error(
              chalk.red(
                "✗ Composing shared agents requires --experimental-shared-compose flag",
              ),
            );
            console.error();
            console.error(
              chalk.dim(
                "  Composing agents from other users carries security risks.",
              ),
            );
            console.error(
              chalk.dim("  Only compose agents from users you trust."),
            );
            process.exit(1);
          }
          await handleGitHubCompose(resolvedConfigFile, options);
        } else {
          // Existing local file flow
          // 1. Load and validate config
          const { config, agentName, agent, basePath } =
            await loadAndValidateConfig(resolvedConfigFile);

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

          // 5. Finalize compose (confirm, merge, upload, display)
          await finalizeCompose(config, agent, variables, options);
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
