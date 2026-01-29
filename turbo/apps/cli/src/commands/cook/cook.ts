import { Command, Option } from "commander";
import chalk from "chalk";
import { readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { config as dotenvConfig } from "dotenv";
import { validateAgentCompose } from "../../lib/domain/yaml-validator";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { checkAndUpgrade } from "../../lib/utils/update-checker";
import { saveCookState } from "../../lib/domain/cook-state";
import {
  CONFIG_FILE,
  ARTIFACT_DIR,
  printCommand,
  execVm0Command,
  execVm0RunWithCapture,
  parseRunIdsFromOutput,
  autoPullArtifact,
} from "./utils";

declare const __CLI_VERSION__: string;

interface VolumeConfig {
  name: string;
  version: string;
}

interface AgentConfig {
  description?: string;
  framework: string;
  image: string;
  volumes?: string[];
  working_dir: string;
  environment?: Record<string, string>;
}

interface AgentComposeConfig {
  version: string;
  agents: Record<string, AgentConfig>;
  volumes?: Record<string, VolumeConfig>;
}

/**
 * Extract all required variable names from compose config
 * Returns unique names from both vars and secrets references
 */
export function extractRequiredVarNames(config: AgentComposeConfig): string[] {
  const refs = extractVariableReferences(config);
  const grouped = groupVariablesBySource(refs);
  // Combine vars and secrets names (both are loaded from .env)
  const varNames = grouped.vars.map((r) => r.name);
  const secretNames = grouped.secrets.map((r) => r.name);
  return [...new Set([...varNames, ...secretNames])];
}

/**
 * Check which variables are missing from environment and optional --env-file
 * @param varNames - Variable names to check
 * @param envFilePath - Optional path to env file (only checked if explicitly provided)
 * @returns Array of missing variable names
 */
export function checkMissingVariables(
  varNames: string[],
  envFilePath?: string,
): string[] {
  // Load env file if explicitly provided
  let fileValues: Record<string, string> = {};
  if (envFilePath) {
    if (!existsSync(envFilePath)) {
      throw new Error(`Environment file not found: ${envFilePath}`);
    }
    const result = dotenvConfig({ path: envFilePath, quiet: true });
    if (result.parsed) {
      fileValues = result.parsed;
    }
  }

  // Check which variables are missing (priority: file > env)
  const missing: string[] = [];
  for (const name of varNames) {
    const inEnv = process.env[name] !== undefined;
    const inFile = fileValues[name] !== undefined;
    if (!inEnv && !inFile) {
      missing.push(name);
    }
  }

  return missing;
}

export const cookAction = new Command()
  .name("cook")
  .description("Quick start: prepare, compose and run agent from vm0.yaml")
  .argument("[prompt]", "Prompt for the agent")
  .option(
    "--env-file <path>",
    "Load environment variables from file (priority: CLI flags > file > env vars)",
  )
  .option("-y, --yes", "Skip confirmation prompts")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (
      prompt: string | undefined,
      options: {
        envFile?: string;
        yes?: boolean;
        debugNoMockClaude?: boolean;
        noAutoUpdate?: boolean;
      },
    ) => {
      // Step 0: Check for updates and auto-upgrade if needed
      if (!options.noAutoUpdate) {
        const shouldExit = await checkAndUpgrade(__CLI_VERSION__, prompt);
        if (shouldExit) {
          process.exit(0);
        }
      }

      const cwd = process.cwd();

      // Step 1: Read and parse config
      console.log(chalk.bold(`Reading config: ${CONFIG_FILE}`));

      if (!existsSync(CONFIG_FILE)) {
        console.error(chalk.red(`✗ Config file not found: ${CONFIG_FILE}`));
        process.exit(1);
      }

      let config: AgentComposeConfig;
      try {
        const content = await readFile(CONFIG_FILE, "utf8");
        config = parseYaml(content) as AgentComposeConfig;
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

      const agentNames = Object.keys(config.agents);
      const agentName = agentNames[0]!;
      const volumeCount = config.volumes
        ? Object.keys(config.volumes).length
        : 0;

      console.log(
        chalk.green(`✓ Config validated: 1 agent, ${volumeCount} volume(s)`),
      );

      // Step 1.5: Check for missing environment variables
      const requiredVarNames = extractRequiredVarNames(config);
      if (requiredVarNames.length > 0) {
        try {
          const missingVars = checkMissingVariables(
            requiredVarNames,
            options.envFile,
          );

          if (missingVars.length > 0) {
            console.log();
            console.error(chalk.red("✗ Missing required variables:"));
            for (const varName of missingVars) {
              console.error(chalk.red(`  ${varName}`));
            }
            console.error(
              chalk.dim(
                "\n  Provide via --env-file, or set as environment variables",
              ),
            );
            process.exit(1);
          }
        } catch (error) {
          if (error instanceof Error) {
            console.error(chalk.red(`✗ ${error.message}`));
          }
          process.exit(1);
        }
      }

      // Step 2: Process volumes
      if (config.volumes && Object.keys(config.volumes).length > 0) {
        console.log();
        console.log(chalk.bold("Processing volumes:"));

        for (const volumeConfig of Object.values(config.volumes)) {
          const volumeDir = path.join(cwd, volumeConfig.name);

          if (!existsSync(volumeDir)) {
            console.error(
              chalk.red(`✗ Directory not found: ${volumeConfig.name}`),
            );
            console.error(
              chalk.dim("  Create the directory and add files first"),
            );
            process.exit(1);
          }

          try {
            printCommand(`cd ${volumeConfig.name}`);

            // Check if already initialized
            const existingConfig = await readStorageConfig(volumeDir);
            if (!existingConfig) {
              printCommand(`vm0 volume init --name ${volumeConfig.name}`);
              await execVm0Command(
                ["volume", "init", "--name", volumeConfig.name],
                {
                  cwd: volumeDir,
                  silent: true,
                },
              );
            }

            // Push volume
            printCommand("vm0 volume push");
            await execVm0Command(["volume", "push"], {
              cwd: volumeDir,
              silent: true,
            });

            printCommand("cd ..");
          } catch (error) {
            console.error(chalk.red(`✗ Failed`));
            if (error instanceof Error) {
              console.error(chalk.dim(`  ${error.message}`));
            }
            process.exit(1);
          }
        }
      }

      // Step 3: Process artifact
      console.log();
      console.log(chalk.bold("Processing artifact:"));

      const artifactDir = path.join(cwd, ARTIFACT_DIR);

      try {
        // Create directory if not exists
        if (!existsSync(artifactDir)) {
          printCommand(`mkdir ${ARTIFACT_DIR}`);
          await mkdir(artifactDir, { recursive: true });
        }

        printCommand(`cd ${ARTIFACT_DIR}`);

        // Check if already initialized
        const existingConfig = await readStorageConfig(artifactDir);
        if (!existingConfig) {
          printCommand(`vm0 artifact init --name ${ARTIFACT_DIR}`);
          await execVm0Command(["artifact", "init", "--name", ARTIFACT_DIR], {
            cwd: artifactDir,
            silent: true,
          });
        }

        // Push artifact
        printCommand("vm0 artifact push");
        await execVm0Command(["artifact", "push"], {
          cwd: artifactDir,
          silent: true,
        });

        printCommand("cd ..");
      } catch (error) {
        console.error(chalk.red(`✗ Failed`));
        if (error instanceof Error) {
          console.error(chalk.dim(`  ${error.message}`));
        }
        process.exit(1);
      }

      // Step 4: Compose agent
      console.log();
      console.log(chalk.bold("Composing agent:"));
      const composeArgs = options.yes
        ? ["compose", "--yes", CONFIG_FILE]
        : ["compose", CONFIG_FILE];
      printCommand(`vm0 ${composeArgs.join(" ")}`);

      try {
        // Use inherit to show compose output and allow confirmation prompts
        await execVm0Command(composeArgs, {
          cwd,
        });
      } catch (error) {
        console.error(chalk.red(`✗ Compose failed`));
        if (error instanceof Error) {
          console.error(chalk.dim(`  ${error.message}`));
        }
        process.exit(1);
      }

      // Step 5: Run agent (if prompt provided)
      if (prompt) {
        console.log();
        console.log(chalk.bold("Running agent:"));
        printCommand(
          `vm0 run ${agentName} --artifact-name ${ARTIFACT_DIR} "${prompt}"`,
        );
        console.log();

        let runOutput: string;
        try {
          const runArgs = [
            "run",
            agentName,
            "--artifact-name",
            ARTIFACT_DIR,
            ...(options.debugNoMockClaude ? ["--debug-no-mock-claude"] : []),
            prompt,
          ];
          runOutput = await execVm0RunWithCapture(runArgs, { cwd });
        } catch {
          // Error already displayed by vm0 run
          process.exit(1);
        }

        // Save session state for continue/resume commands
        const runIds = parseRunIdsFromOutput(runOutput);
        if (runIds.runId || runIds.sessionId || runIds.checkpointId) {
          await saveCookState({
            lastRunId: runIds.runId,
            lastSessionId: runIds.sessionId,
            lastCheckpointId: runIds.checkpointId,
          });
        }

        // Step 6: Auto-pull artifact if run completed with artifact changes
        await autoPullArtifact(runOutput, artifactDir);
      } else {
        console.log();
        console.log("To run your agent:");
        printCommand(
          `vm0 run ${agentName} --artifact-name ${ARTIFACT_DIR} "your prompt"`,
        );
      }
    },
  );
