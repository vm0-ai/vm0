import { Command, Option } from "commander";
import chalk from "chalk";
import { readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import {
  getComposeByName,
  createOrUpdateCompose,
  listZeroSecrets,
  listZeroVariables,
  listZeroConnectors,
} from "../../lib/api";
import { validateAgentCompose } from "../../lib/domain/yaml-validator";
import { downloadGitHubDirectory } from "../../lib/domain/github-skills";
import { uploadInstructions } from "../../lib/storage/system-storage";
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
  return new Set(
    grouped.secrets.map((r) => {
      return r.name;
    }),
  );
}

/**
 * Extract variable names from compose content using variable references.
 * Looks for ${{ vars.XXX }} patterns in the compose.
 */
function getVarsFromComposeContent(content: unknown): Set<string> {
  const grouped = extractAndGroupVariables(content);
  return new Set(
    grouped.vars.map((r) => {
      return r.name;
    }),
  );
}

interface AgentConfig {
  instructions?: string;
  framework?: string;
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

async function uploadInstructionsIfPresent(
  agentName: string,
  agent: AgentConfig,
  basePath: string,
  jsonMode?: boolean,
): Promise<void> {
  if (!agent.instructions) return;

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

/**
 * Remove legacy `skills:` fields from every agent before POSTing the compose.
 * Belt-and-braces with server-side stripping planned in sibling sub-issue #9754.
 */
function stripSkillsFromAgents(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const cfg = structuredClone(config) as Record<string, unknown>;
  const agents = cfg.agents;
  if (agents && typeof agents === "object" && !Array.isArray(agents)) {
    for (const agent of Object.values(agents as Record<string, unknown>)) {
      if (agent && typeof agent === "object" && !Array.isArray(agent)) {
        delete (agent as Record<string, unknown>).skills;
      }
    }
  }
  return cfg;
}

/**
 * Derive the app URL from the API URL by replacing "www" with "app" in the hostname.
 */
interface MissingItemsResult {
  missingSecrets: string[];
  missingVars: string[];
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
      requiredSecrets.size > 0 ? listZeroSecrets() : { secrets: [] },
      requiredVars.size > 0 ? listZeroVariables() : { variables: [] },
      listZeroConnectors(),
    ]);

  const existingSecretNames = new Set(
    secretsResponse.secrets.map((s) => {
      return s.name;
    }),
  );
  const existingVarNames = new Set(
    variablesResponse.variables.map((v) => {
      return v.name;
    }),
  );

  // Connector-provided environment names (e.g., GH_TOKEN from GitHub connector)
  // Use server-computed list to avoid CLI/server version skew issues
  const connectorProvidedEnvNames = new Set(
    connectorsResponse.connectorProvidedEnvNames,
  );

  const missingSecrets = [...requiredSecrets].filter((name) => {
    return (
      !existingSecretNames.has(name) && !connectorProvidedEnvNames.has(name)
    );
  });
  const missingVars = [...requiredVars].filter((name) => {
    return !existingVarNames.has(name);
  });

  if (missingSecrets.length === 0 && missingVars.length === 0) {
    return { missingSecrets: [], missingVars: [] };
  }

  if (!options.json) {
    console.log();
    console.log(chalk.yellow("⚠ Missing secrets/variables detected:"));
    if (missingSecrets.length > 0) {
      console.log(chalk.yellow(`  Secrets: ${missingSecrets.join(", ")}`));
    }
    if (missingVars.length > 0) {
      console.log(chalk.yellow(`  Variables: ${missingVars.join(", ")}`));
    }
    console.log();
  }

  return { missingSecrets, missingVars };
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
}

/**
 * Finalize compose: call API and display result.
 * Shared by both GitHub URL and local file flows.
 * Returns the compose result for JSON output mode.
 */
async function finalizeCompose(
  config: unknown,
  agent: AgentConfig,
  options: { yes?: boolean; autoUpdate?: boolean; json?: boolean },
): Promise<ComposeResult> {
  // Call API
  if (!options.json) {
    console.log("Uploading compose...");
  }
  const contentToPost = stripSkillsFromAgents(config);
  const response = await createOrUpdateCompose({ content: contentToPost });

  const shortVersionId = response.versionId.slice(0, 8);
  const displayName = response.name;

  // Build result
  const result: ComposeResult = {
    composeId: response.composeId,
    composeName: response.name,
    versionId: response.versionId,
    action: response.action,
    displayName,
  };

  // In --json mode, skip missing items check — E2B doesn't read these fields
  if (!options.json) {
    const missingItems = await checkAndPromptMissingItems(config, options);
    if (
      missingItems.missingSecrets.length > 0 ||
      missingItems.missingVars.length > 0
    ) {
      result.missingSecrets = missingItems.missingSecrets;
      result.missingVars = missingItems.missingVars;
    }
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
        `    vm0 run ${displayName}:${shortVersionId} --artifact <artifact> "your prompt"`,
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

    // Upload instructions
    await uploadInstructionsIfPresent(agentName, agent, basePath, options.json);

    // Finalize compose (upload, display)
    return await finalizeCompose(config, agent, options);
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
  .option("-y, --yes", "Skip confirmation prompts")
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

            // 3. Upload instructions
            await uploadInstructionsIfPresent(
              agentName,
              agent,
              basePath,
              options.json,
            );

            // 4. Finalize compose (upload, display)
            result = await finalizeCompose(config, agent, options);
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
