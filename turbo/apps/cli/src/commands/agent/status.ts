import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, getComposeVersion } from "../../lib/api";
import {
  deriveComposeVariableSources,
  type AgentVariableSources,
} from "../../lib/domain/source-derivation";

/**
 * Agent definition from compose content
 */
interface AgentDefinition {
  description?: string;
  image?: string;
  framework: string;
  apps?: string[];
  volumes?: string[];
  working_dir?: string;
  environment?: Record<string, string>;
  instructions?: string;
  skills?: string[];
  experimental_runner?: {
    group: string;
  };
}

/**
 * Volume configuration from compose content
 */
interface VolumeConfig {
  name: string;
  version: string;
}

/**
 * Agent compose content structure
 */
interface AgentComposeContent {
  version: string;
  agents: Record<string, AgentDefinition>;
  volumes?: Record<string, VolumeConfig>;
}

/**
 * Format a list section with label and items
 */
function formatListSection(label: string, items: string[]): void {
  if (items.length === 0) return;
  console.log(`    ${label}:`);
  for (const item of items) {
    console.log(`      - ${item}`);
  }
}

/**
 * Format volumes with optional version resolution
 */
function formatVolumes(
  volumes: string[],
  volumeConfigs?: Record<string, VolumeConfig>,
): void {
  if (volumes.length === 0) return;
  console.log(`    Volumes:`);
  for (const vol of volumes) {
    const volumeDef = volumeConfigs?.[vol];
    if (volumeDef) {
      console.log(`      - ${vol}:${volumeDef.version.slice(0, 8)}`);
    } else {
      console.log(`      - ${vol}`);
    }
  }
}

/**
 * Format secrets and vars with source information
 */
function formatVariableSources(sources: AgentVariableSources): void {
  if (sources.secrets.length > 0) {
    console.log(`    Secrets:`);
    for (const secret of sources.secrets) {
      const sourceInfo = chalk.dim(`(${secret.source})`);
      console.log(`      - ${secret.name.padEnd(20)} ${sourceInfo}`);
    }
  }
  if (sources.vars.length > 0) {
    console.log(`    Vars:`);
    for (const v of sources.vars) {
      const sourceInfo = chalk.dim(`(${v.source})`);
      console.log(`      - ${v.name.padEnd(20)} ${sourceInfo}`);
    }
  }
}

/**
 * Format details for a single agent
 */
function formatAgentDetails(
  agentName: string,
  agent: AgentDefinition,
  agentSources: AgentVariableSources | undefined,
  volumeConfigs: Record<string, VolumeConfig> | undefined,
): void {
  console.log(`  ${chalk.cyan(agentName)}:`);
  console.log(`    Framework: ${agent.framework}`);

  if (agent.image) {
    console.log(`    Image:    ${agent.image}`);
  }

  formatListSection("Apps", agent.apps ?? []);

  if (agent.working_dir) {
    console.log(`    Working Dir: ${agent.working_dir}`);
  }

  formatVolumes(agent.volumes ?? [], volumeConfigs);
  formatListSection("Skills", agent.skills ?? []);

  if (agentSources) {
    formatVariableSources(agentSources);
  }

  if (agent.experimental_runner) {
    console.log(`    Runner: ${agent.experimental_runner.group}`);
  }
}

/**
 * Format the compose content for display
 */
function formatComposeOutput(
  name: string,
  versionId: string,
  content: AgentComposeContent,
  variableSources?: Map<string, AgentVariableSources>,
): void {
  console.log(chalk.bold("Name:") + `    ${name}`);
  console.log(chalk.bold("Version:") + ` ${versionId}`);
  console.log();

  console.log(chalk.bold("Agents:"));
  for (const [agentName, agent] of Object.entries(content.agents)) {
    const agentSources = variableSources?.get(agentName);
    formatAgentDetails(agentName, agent, agentSources, content.volumes);
  }
}

export const statusCommand = new Command()
  .name("status")
  .description("Show status of agent compose")
  .argument(
    "<name[:version]>",
    "Agent name with optional version (e.g., my-agent:latest or my-agent:a1b2c3d4)",
  )
  .option("-s, --scope <scope>", "Scope to look up the compose from")
  .option("--no-sources", "Skip fetching skills to determine variable sources")
  .action(
    async (
      argument: string,
      options: { scope?: string; sources?: boolean },
    ) => {
      try {
        // Parse NAME:VERSION argument
        const colonIndex = argument.lastIndexOf(":");
        let name: string;
        let version: string;

        if (colonIndex === -1) {
          name = argument;
          version = "latest";
        } else {
          name = argument.slice(0, colonIndex);
          version = argument.slice(colonIndex + 1) || "latest";
        }

        // Get compose by name
        const compose = await getComposeByName(name, options.scope);

        if (!compose) {
          console.error(chalk.red(`✗ Agent compose not found: ${name}`));
          console.error(chalk.dim("  Run: vm0 agent list"));
          process.exit(1);
        }

        // Resolve version if not "latest" or full hash
        let resolvedVersionId = compose.headVersionId;

        if (version !== "latest" && compose.headVersionId) {
          // Check if it's already a full hash or needs resolution
          if (version.length < 64) {
            // Resolve the version prefix
            try {
              const versionInfo = await getComposeVersion(compose.id, version);
              resolvedVersionId = versionInfo.versionId;
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.includes("not found")
              ) {
                console.error(chalk.red(`✗ Version not found: ${version}`));
                console.error(
                  chalk.dim(
                    `  HEAD version: ${compose.headVersionId?.slice(0, 8)}`,
                  ),
                );
                process.exit(1);
              }
              throw error;
            }
          } else {
            resolvedVersionId = version;
          }
        }

        if (!resolvedVersionId || !compose.content) {
          console.error(chalk.red(`✗ No version found for: ${name}`));
          process.exit(1);
        }

        const content = compose.content as AgentComposeContent;

        // Derive variable sources if --no-sources flag is not set
        // Default: sources = true (enabled), --no-sources sets it to false
        let variableSources: Map<string, AgentVariableSources> | undefined;
        if (options.sources !== false) {
          try {
            variableSources = await deriveComposeVariableSources(content);
          } catch {
            // Failed to derive sources, show warning and continue without them
            console.error(
              chalk.yellow(
                "⚠ Warning: Failed to fetch skill sources, showing basic info",
              ),
            );
          }
        }

        // Format and display the compose
        formatComposeOutput(
          compose.name,
          resolvedVersionId,
          content,
          variableSources,
        );
      } catch (error) {
        console.error(chalk.red("✗ Failed to get agent compose status"));
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(chalk.dim("  Run: vm0 auth login"));
          } else {
            console.error(chalk.dim(`  ${error.message}`));
          }
        }
        process.exit(1);
      }
    },
  );
