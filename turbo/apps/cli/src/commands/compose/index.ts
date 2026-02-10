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
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import {
  getComposeByName,
  createOrUpdateCompose,
  getScope,
  listSecrets,
  listVariables,
  listConnectors,
} from "../../lib/api";
import { getApiUrl } from "../../lib/api/config";
import { validateAgentCompose } from "../../lib/domain/yaml-validator";
import { downloadGitHubDirectory } from "../../lib/domain/github-skills";
import {
  uploadInstructions,
  uploadSkill,
  type SkillUploadResult,
} from "../../lib/storage/system-storage";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import {
  startSilentUpgrade,
  waitForSilentUpgrade,
} from "../../lib/utils/update-checker";

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

/**
 * Extract variable names from compose content using variable references.
 * Looks for ${{ vars.XXX }} patterns in the compose.
 */
function getVarsFromComposeContent(content: unknown): Set<string> {
  const refs = extractVariableReferences(content);
  const grouped = groupVariablesBySource(refs);
  return new Set(grouped.vars.map((r) => r.name));
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
  jsonMode?: boolean,
): Promise<LoadedConfig> {
  if (!existsSync(configFile)) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ error: `Config file not found: ${configFile}` }),
      );
    } else {
      console.error(chalk.red(`✗ Config file not found: ${configFile}`));
    }
    process.exit(1);
  }

  const content = await readFile(configFile, "utf8");

  let config: unknown;
  try {
    config = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (jsonMode) {
      console.log(JSON.stringify({ error: `Invalid YAML format: ${message}` }));
    } else {
      console.error(chalk.red("✗ Invalid YAML format"));
      console.error(chalk.dim(`  ${message}`));
    }
    process.exit(1);
  }

  const validation = validateAgentCompose(config);
  if (!validation.valid) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: validation.error }));
    } else {
      console.error(chalk.red(`✗ ${validation.error}`));
    }
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
  jsonMode?: boolean,
): Promise<SkillUploadResult[]> {
  if (agent.instructions) {
    if (!jsonMode) {
      console.log(`Uploading instructions: ${agent.instructions}`);
    }
    const result = await uploadInstructions(
      agentName,
      agent.instructions,
      basePath,
      agent.framework,
    );
    if (!jsonMode) {
      console.log(
        chalk.green(
          `✓ Instructions ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.versionId.slice(0, 8)}`,
        ),
      );
    }
  }

  const skillResults: SkillUploadResult[] = [];
  if (agent.skills && Array.isArray(agent.skills)) {
    if (!jsonMode) {
      console.log(`Uploading ${agent.skills.length} skill(s)...`);
    }
    for (const skillUrl of agent.skills) {
      if (!jsonMode) {
        console.log(chalk.dim(`  Downloading: ${skillUrl}`));
      }
      const result = await uploadSkill(skillUrl);
      skillResults.push(result);
      if (!jsonMode) {
        console.log(
          chalk.green(
            `  ✓ Skill ${result.action === "deduplicated" ? "(unchanged)" : "uploaded"}: ${result.skillName} (${result.versionId.slice(0, 8)})`,
          ),
        );
      }
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
  options: { yes?: boolean; json?: boolean },
): Promise<boolean> {
  const { newSecrets, newVars, trulyNewSecrets } = variables;

  if (newSecrets.length === 0 && newVars.length === 0) {
    return true;
  }

  // In JSON mode, skip display but still check for new secrets
  if (!options.json) {
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
  }

  if (trulyNewSecrets.length > 0 && !options.yes) {
    if (!isInteractive()) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: `New secrets detected: ${trulyNewSecrets.join(", ")}. Use --yes flag to approve.`,
          }),
        );
      } else {
        console.error(
          chalk.red(`✗ New secrets detected: ${trulyNewSecrets.join(", ")}`),
        );
        console.error(
          chalk.dim(
            "  Use --yes flag to approve new secrets in non-interactive mode.",
          ),
        );
      }
      process.exit(1);
    }

    const confirmed = await promptConfirm(
      `Approve ${trulyNewSecrets.length} new secret(s)?`,
      true,
    );
    if (!confirmed) {
      if (!options.json) {
        console.log(chalk.yellow("Compose cancelled"));
      }
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
 * Derive the platform URL from the API URL by replacing "www" with "platform" in the hostname.
 */
function getPlatformUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.hostname = url.hostname.replace("www", "platform");
  return url.origin;
}

interface MissingItemsResult {
  missingSecrets: string[];
  missingVars: string[];
  setupUrl?: string;
}

/**
 * Check for missing secrets/vars and print setup URL if any are missing.
 */
async function checkAndPromptMissingItems(
  config: unknown,
  options: { json?: boolean },
): Promise<MissingItemsResult> {
  const requiredSecrets = getSecretsFromComposeContent(config);
  const requiredVars = getVarsFromComposeContent(config);

  if (requiredSecrets.size === 0 && requiredVars.size === 0) {
    return { missingSecrets: [], missingVars: [] };
  }

  const [secretsResponse, variablesResponse, connectorsResponse] =
    await Promise.all([
      requiredSecrets.size > 0 ? listSecrets() : { secrets: [] },
      requiredVars.size > 0 ? listVariables() : { variables: [] },
      listConnectors(),
    ]);

  const existingSecretNames = new Set(
    secretsResponse.secrets.map((s) => s.name),
  );
  const existingVarNames = new Set(
    variablesResponse.variables.map((v) => v.name),
  );

  // Connector-provided secrets (e.g., GH_TOKEN from GitHub connector)
  const connectorProvided = getConnectorProvidedSecretNames(
    connectorsResponse.connectors.map((c) => c.type),
  );

  const missingSecrets = [...requiredSecrets].filter(
    (name) => !existingSecretNames.has(name) && !connectorProvided.has(name),
  );
  const missingVars = [...requiredVars].filter(
    (name) => !existingVarNames.has(name),
  );

  if (missingSecrets.length === 0 && missingVars.length === 0) {
    return { missingSecrets: [], missingVars: [] };
  }

  const apiUrl = await getApiUrl();
  const platformUrl = getPlatformUrl(apiUrl);
  const params = new URLSearchParams();
  if (missingSecrets.length > 0) {
    params.set("secrets", missingSecrets.join(","));
  }
  if (missingVars.length > 0) {
    params.set("vars", missingVars.join(","));
  }
  const setupUrl = `${platformUrl}/environment-variables-setup?${params.toString()}`;

  if (!options.json) {
    console.log();
    console.log(
      chalk.yellow(
        "⚠ Missing secrets/variables detected. Set them up before running your agent:",
      ),
    );
    console.log(chalk.cyan(`  ${setupUrl}`));
    console.log();
  }

  return { missingSecrets, missingVars, setupUrl };
}

/**
 * Result from finalizeCompose for JSON output
 */
interface ComposeResult {
  composeId: string;
  composeName: string;
  versionId: string;
  action: "created" | "existing";
  displayName: string;
  missingSecrets?: string[];
  missingVars?: string[];
  setupUrl?: string;
}

/**
 * Finalize compose: confirm variables, merge into config, call API, and display result.
 * Shared by both GitHub URL and local file flows.
 * Returns the compose result for JSON output mode.
 */
async function finalizeCompose(
  config: unknown,
  agent: AgentConfig,
  variables: SkillVariables,
  options: { yes?: boolean; autoUpdate?: boolean; json?: boolean },
): Promise<ComposeResult> {
  // Display variables and confirm with user
  const confirmed = await displayAndConfirmVariables(variables, options);
  if (!confirmed) {
    process.exit(0);
  }

  // Merge skill variables into environment
  mergeSkillVariables(agent, variables);

  // Call API
  if (!options.json) {
    console.log("Uploading compose...");
  }
  const response = await createOrUpdateCompose({ content: config });

  // Get scope for display name
  const scopeResponse = await getScope();
  const shortVersionId = response.versionId.slice(0, 8);
  const displayName = `${scopeResponse.slug}/${response.name}`;

  // Build result
  const result: ComposeResult = {
    composeId: response.composeId,
    composeName: response.name,
    versionId: response.versionId,
    action: response.action,
    displayName,
  };

  // Check for missing secrets/vars before showing run command
  const missingItems = await checkAndPromptMissingItems(config, options);
  if (
    missingItems.missingSecrets.length > 0 ||
    missingItems.missingVars.length > 0
  ) {
    result.missingSecrets = missingItems.missingSecrets;
    result.missingVars = missingItems.missingVars;
    result.setupUrl = missingItems.setupUrl;
  }

  // Display human-readable result (skip in JSON mode)
  if (!options.json) {
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
  }

  // Wait for upgrade at command end (shows warning if failed)
  if (options.autoUpdate !== false) {
    await waitForSilentUpgrade();
  }

  return result;
}

/**
 * Handle compose from GitHub URL
 */
async function handleGitHubCompose(
  url: string,
  options: { yes?: boolean; autoUpdate?: boolean; json?: boolean },
): Promise<ComposeResult> {
  if (!options.json) {
    console.log(`Downloading from GitHub: ${url}`);
  }

  const { dir: downloadedDir, tempRoot } = await downloadGitHubDirectory(url);
  const configFile = join(downloadedDir, "vm0.yaml");

  try {
    if (!existsSync(configFile)) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: "vm0.yaml not found in the GitHub directory",
          }),
        );
      } else {
        console.error(
          chalk.red(`✗ vm0.yaml not found in the GitHub directory`),
        );
        console.error(chalk.dim(`  URL: ${url}`));
      }
      process.exit(1);
    }

    // Load and validate config
    const { config, agentName, agent, basePath } = await loadAndValidateConfig(
      configFile,
      options.json,
    );

    // Check if agent with same name already exists
    const existingCompose = await getComposeByName(agentName);
    if (existingCompose) {
      if (!options.json) {
        console.log();
        console.log(
          chalk.yellow(`⚠ An agent named "${agentName}" already exists.`),
        );
      }

      if (!isInteractive()) {
        // Non-interactive mode: require --yes flag to overwrite
        if (!options.yes) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error:
                  "Cannot overwrite existing agent in non-interactive mode",
              }),
            );
          } else {
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
          }
          process.exit(1);
        }
      } else {
        // Interactive mode: prompt user (default No)
        const confirmed = await promptConfirm(
          "Do you want to overwrite it?",
          false,
        );
        if (!confirmed) {
          if (!options.json) {
            console.log(chalk.yellow("Compose cancelled."));
          }
          process.exit(0);
        }
      }
    }

    // Check for unsupported volumes
    if (hasVolumes(config)) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: "Volumes are not supported for GitHub URL compose",
          }),
        );
      } else {
        console.error(
          chalk.red(`✗ Volumes are not supported for GitHub URL compose`),
        );
        console.error(
          chalk.dim(
            `  Clone the repository locally and run: vm0 compose ./path/to/vm0.yaml`,
          ),
        );
      }
      process.exit(1);
    }

    // Check for legacy image format (skip in JSON mode)
    if (!options.json) {
      checkLegacyImageFormat(config);
    }

    // Upload instructions and skills
    const skillResults = await uploadAssets(
      agentName,
      agent,
      basePath,
      options.json,
    );

    // Collect and process skill variables
    const environment = agent.environment || {};
    const variables = await collectSkillVariables(
      skillResults,
      environment,
      agentName,
    );

    // Finalize compose (confirm, merge, upload, display)
    return await finalizeCompose(config, agent, variables, options);
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
    "[deprecated] No longer required, kept for backward compatibility",
  )
  .option("--json", "Output JSON for scripts (suppresses interactive output)")
  .option(
    "--porcelain",
    "[deprecated: use --json] Output JSON for scripts",
    false,
  )
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
    async (
      configFile: string | undefined,
      options: {
        yes?: boolean;
        autoUpdate?: boolean;
        experimentalSharedCompose?: boolean;
        json?: boolean;
        porcelain?: boolean;
      },
    ) => {
      const resolvedConfigFile = configFile ?? DEFAULT_CONFIG_FILE;

      // Handle deprecated --porcelain flag
      if (options.porcelain && !options.json) {
        console.error(
          chalk.yellow("⚠ --porcelain is deprecated, use --json instead"),
        );
        options.json = true;
      }

      // JSON mode implies --yes and disables auto-update (for CI/CD usage)
      if (options.json) {
        options.yes = true;
        options.autoUpdate = false;
      }

      // Start upgrade in background at command start (runs in parallel)
      if (options.autoUpdate !== false) {
        await startSilentUpgrade(__CLI_VERSION__);
      }

      try {
        let result: ComposeResult;

        // Branch based on input type
        if (isGitHubUrl(resolvedConfigFile)) {
          result = await handleGitHubCompose(resolvedConfigFile, options);
        } else {
          // Existing local file flow
          // 1. Load and validate config
          const { config, agentName, agent, basePath } =
            await loadAndValidateConfig(resolvedConfigFile, options.json);

          // 2. Check for legacy image format (skip in JSON mode)
          if (!options.json) {
            checkLegacyImageFormat(config);
          }

          // 3. Upload instructions and skills
          const skillResults = await uploadAssets(
            agentName,
            agent,
            basePath,
            options.json,
          );

          // 4. Collect and process skill variables
          const environment = agent.environment || {};
          const variables = await collectSkillVariables(
            skillResults,
            environment,
            agentName,
          );

          // 5. Finalize compose (confirm, merge, upload, display)
          result = await finalizeCompose(config, agent, variables, options);
        }

        // Output JSON result if requested
        if (options.json) {
          console.log(JSON.stringify(result));
        }
      } catch (error) {
        if (options.json) {
          const message =
            error instanceof Error
              ? error.message
              : "An unexpected error occurred";
          console.log(JSON.stringify({ error: message }));
          process.exit(1);
        }

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
