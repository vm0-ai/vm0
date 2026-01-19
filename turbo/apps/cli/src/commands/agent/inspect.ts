import { Command } from "commander";
import chalk from "chalk";
import { apiClient, type GetComposeResponse } from "../../lib/api/api-client";
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
  provider: string;
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
    console.log(`  ${chalk.cyan(agentName)}:`);
    console.log(`    Provider: ${agent.provider}`);

    if (agent.image) {
      console.log(`    Image:    ${agent.image}`);
    }

    if (agent.apps && agent.apps.length > 0) {
      console.log(`    Apps:`);
      for (const app of agent.apps) {
        console.log(`      - ${app}`);
      }
    }

    if (agent.working_dir) {
      console.log(`    Working Dir: ${agent.working_dir}`);
    }

    // Show volumes if defined
    if (agent.volumes && agent.volumes.length > 0) {
      console.log(`    Volumes:`);
      for (const vol of agent.volumes) {
        // Check if volume has a defined version in compose
        const volumeDef = content.volumes?.[vol];
        if (volumeDef) {
          console.log(`      - ${vol}:${volumeDef.version.slice(0, 8)}`);
        } else {
          console.log(`      - ${vol}`);
        }
      }
    }

    // Show skills if defined
    if (agent.skills && agent.skills.length > 0) {
      console.log(`    Skills:`);
      for (const skill of agent.skills) {
        console.log(`      - ${skill}`);
      }
    }

    // Show secrets/vars with source information
    const agentSources = variableSources?.get(agentName);

    if (agentSources) {
      // Display with source information
      if (agentSources.secrets.length > 0) {
        console.log(`    Secrets:`);
        for (const secret of agentSources.secrets) {
          const sourceInfo = chalk.dim(`(${secret.source})`);
          console.log(`      - ${secret.name.padEnd(20)} ${sourceInfo}`);
        }
      }

      if (agentSources.vars.length > 0) {
        console.log(`    Vars:`);
        for (const v of agentSources.vars) {
          const sourceInfo = chalk.dim(`(${v.source})`);
          console.log(`      - ${v.name.padEnd(20)} ${sourceInfo}`);
        }
      }
    }

    // Show runner configuration if defined
    if (agent.experimental_runner) {
      console.log(`    Runner: ${agent.experimental_runner.group}`);
    }
  }
}

export const inspectCommand = new Command()
  .name("inspect")
  .description("Inspect an agent compose")
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
        let compose: GetComposeResponse;
        try {
          compose = await apiClient.getComposeByName(name, options.scope);
        } catch (error) {
          if (error instanceof Error && error.message.includes("not found")) {
            console.error(chalk.red(`✗ Agent compose not found: ${name}`));
            console.error(chalk.dim("  Run: vm0 agent list"));
            process.exit(1);
          }
          throw error;
        }

        // Resolve version if not "latest" or full hash
        let resolvedVersionId = compose.headVersionId;

        if (version !== "latest" && compose.headVersionId) {
          // Check if it's already a full hash or needs resolution
          if (version.length < 64) {
            // Resolve the version prefix
            try {
              const versionInfo = await apiClient.getComposeVersion(
                compose.id,
                version,
              );
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
        console.error(chalk.red("✗ Failed to inspect agent compose"));
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
