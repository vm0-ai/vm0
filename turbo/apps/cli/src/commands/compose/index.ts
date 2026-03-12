import { Command, Option } from "commander";
import chalk from "chalk";
import { readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import {
  getLegacySystemTemplateWarning,
  extractAndGroupVariables,
  resolveSkillRef,
  connectorTypeSchema,
  getServiceConfig,
} from "@vm0/core";
import type { ExpandedServiceConfig } from "@vm0/core";
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
import { withErrorHandler } from "../../lib/command";

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
  const grouped = extractAndGroupVariables(content);
  return new Set(grouped.secrets.map((r) => r.name));
}

/**
 * Extract variable names from compose content using variable references.
 * Looks for ${{ vars.XXX }} patterns in the compose.
 */
function getVarsFromComposeContent(content: unknown): Set<string> {
  const grouped = extractAndGroupVariables(content);
  return new Set(grouped.vars.map((r) => r.name));
}

interface AgentConfig {
  instructions?: string;
  framework?: string;
  skills?: string[];
  environment?: Record<string, string>;
  metadata?: { displayName?: string; sound?: string };
  experimental_services?: string[];
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
    throw new Error(`Config file not found: ${configFile}`);
  }

  const content = await readFile(configFile, "utf8");

  let config: unknown;
  try {
    config = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Invalid YAML format: ${message}`);
  }

  const validation = validateAgentCompose(config);
  if (!validation.valid) {
    throw new Error(validation.error);
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
          `⚠ Agent "${name}": 'image' field is deprecated and will be ignored. The server resolves the image based on the framework.`,
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
      agent.metadata,
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
    // Normalize bare skill names to full GitHub URLs before upload
    agent.skills = agent.skills.map(resolveSkillRef);

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
      throw new Error(`New secrets detected: ${trulyNewSecrets.join(", ")}`, {
        cause: new Error(
          "Use --yes flag to approve new secrets in non-interactive mode.",
        ),
      });
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
 * Expand experimental_services from string[] to ExpandedServiceConfig[] in-place.
 * Mutates the config object so the API receives pre-expanded service objects.
 *
 * TODO: Support resolving services from GitHub URLs (like skills).
 * Currently only resolves from built-in SERVICE_CONFIGS via connectorTypeSchema.
 */
function expandServiceConfigs(config: unknown): void {
  const compose = config as {
    agents?: Record<
      string,
      { experimental_services?: string[] | ExpandedServiceConfig[] }
    >;
  };
  if (!compose?.agents) return;

  for (const agent of Object.values(compose.agents)) {
    const services = agent.experimental_services;
    if (!services || services.length === 0) continue;
    // Skip if already expanded (object array, not string array)
    if (typeof services[0] !== "string") continue;

    agent.experimental_services = (services as string[]).map((name) => {
      const parsed = connectorTypeSchema.safeParse(name);
      if (!parsed.success) {
        throw new Error(`Unknown service: "${name}"`);
      }
      const serviceConfig = getServiceConfig(parsed.data);
      if (!serviceConfig) {
        throw new Error(
          `Service "${name}" does not support proxy-side token replacement`,
        );
      }
      return {
        name,
        apis: serviceConfig.apis,
        placeholders: serviceConfig.placeholders,
      };
    });
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
  // Use server-computed list to avoid CLI/server version skew issues
  const connectorProvided = new Set(
    connectorsResponse.connectorProvidedSecretNames,
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

  // Expand experimental_services from names to full configs before sending to API
  expandServiceConfigs(config);

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
      throw new Error("vm0.yaml not found in the GitHub directory", {
        cause: new Error(`URL: ${url}`),
      });
    }

    // Load and validate config
    const { config, agentName, agent, basePath } =
      await loadAndValidateConfig(configFile);

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
          throw new Error(
            "Cannot overwrite existing agent in non-interactive mode",
            {
              cause: new Error(
                "Use --yes flag to confirm overwriting the existing agent.",
              ),
            },
          );
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
      throw new Error("Volumes are not supported for GitHub URL compose", {
        cause: new Error(
          "Clone the repository locally and run: vm0 compose ./path/to/vm0.yaml",
        ),
      });
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
    withErrorHandler(
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
              await loadAndValidateConfig(resolvedConfigFile);

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

          throw error;
        }
      },
    ),
  );
