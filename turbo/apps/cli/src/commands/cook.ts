import { Command, Option } from "commander";
import chalk from "chalk";
import { readFile, mkdir, writeFile, appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { parse as parseYaml } from "yaml";
import { config as dotenvConfig } from "dotenv";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { validateAgentCompose } from "../lib/domain/yaml-validator";
import { readStorageConfig } from "../lib/storage/storage-utils";
import { checkAndUpgrade } from "../lib/utils/update-checker";
import { loadCookState, saveCookState } from "../lib/domain/cook-state";

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

export const CONFIG_FILE = "vm0.yaml";
const ARTIFACT_DIR = "artifact";

/**
 * Print a command hint for tutorial output
 */
function printCommand(cmd: string): void {
  console.log(chalk.dim(`> ${cmd}`));
}

/**
 * Execute a vm0 command in a subprocess
 * Returns stdout on success, throws on failure with stderr
 *
 * @param options.silent - If true, capture stdout/stderr (no output to terminal)
 */
function execVm0Command(
  args: string[],
  options: { cwd?: string; silent?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Determine stdio configuration:
    // - silent: pipe all (capture output, no terminal interaction)
    // - default: inherit all (full terminal passthrough, allows prompts)
    const stdio: "pipe" | "inherit" = options.silent ? "pipe" : "inherit";

    const proc = spawn("vm0", args, {
      cwd: options.cwd,
      stdio,
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    if (options.silent) {
      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command failed with exit code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Execute vm0 run command while capturing output for artifact version parsing
 * Streams output to console while also capturing it
 * Returns the captured stdout
 */
function execVm0RunWithCapture(
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("vm0", args, {
      cwd: options.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command failed with exit code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Parse artifact version from vm0 run completion output
 * Looks for pattern like:
 *   ✓ Run completed successfully
 *   ...
 *   Artifact:
 *     artifactName: abc12345
 * Returns the version string (8 char truncated hash)
 */
function parseArtifactVersionFromCompletion(
  output: string,
  artifactName: string,
): string | null {
  // Find the completion section marker
  const completionMarker = "Run completed successfully";
  const completionIndex = output.indexOf(completionMarker);
  if (completionIndex === -1) return null;

  // Get the completion section
  const section = output.slice(completionIndex);

  // Look for Artifact section and extract version
  // Pattern: "    artifactName: version" (with ANSI codes possibly)
  const artifactPattern = new RegExp(
    `^\\s*${escapeRegExp(artifactName)}:\\s*(?:\\x1b\\[[0-9;]*m)?([a-f0-9]+)`,
    "m",
  );
  const match = section.match(artifactPattern);
  return match ? match[1]! : null;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse run IDs from vm0 run completion output
 * Extracts runId, sessionId, and checkpointId from the "Next steps" section
 */
interface ParsedRunIds {
  runId?: string;
  sessionId?: string;
  checkpointId?: string;
}

export function parseRunIdsFromOutput(output: string): ParsedRunIds {
  const completionMarker = "Run completed successfully";
  const completionIndex = output.indexOf(completionMarker);
  if (completionIndex === -1) return {};

  const section = output.slice(completionIndex);

  // Strip ANSI codes for reliable matching
  // ESC character (0x1B) followed by [ and ANSI sequence
  const ESC = String.fromCharCode(0x1b);
  const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  const stripped = section.replace(ansiPattern, "");

  return {
    runId: stripped.match(/vm0 logs ([0-9a-f-]{36})/)?.[1],
    sessionId: stripped.match(/vm0 run continue ([0-9a-f-]{36})/)?.[1],
    checkpointId: stripped.match(/vm0 run resume ([0-9a-f-]{36})/)?.[1],
  };
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
 * Check which variables are missing from environment and .env file
 * @param varNames - Variable names to check
 * @param envFilePath - Path to .env file
 * @returns Array of missing variable names
 */
export function checkMissingVariables(
  varNames: string[],
  envFilePath: string,
): string[] {
  // Load .env file if it exists
  let dotenvValues: Record<string, string> = {};
  if (existsSync(envFilePath)) {
    const result = dotenvConfig({ path: envFilePath, quiet: true });
    if (result.parsed) {
      dotenvValues = result.parsed;
    }
  }

  // Check which variables are missing
  const missing: string[] = [];
  for (const name of varNames) {
    const inEnv = process.env[name] !== undefined;
    const inDotenv = dotenvValues[name] !== undefined;
    if (!inEnv && !inDotenv) {
      missing.push(name);
    }
  }

  return missing;
}

/**
 * Generate .env file with placeholder entries for missing variables
 * Creates file if it doesn't exist, appends to existing file
 * @param missingVars - Variable names to add as placeholders
 * @param envFilePath - Path to .env file
 */
export async function generateEnvPlaceholders(
  missingVars: string[],
  envFilePath: string,
): Promise<void> {
  const placeholders = missingVars.map((name) => `${name}=`).join("\n");

  if (existsSync(envFilePath)) {
    // Read existing content to check if we need a newline
    const existingContent = readFileSync(envFilePath, "utf8");
    const needsNewline =
      existingContent.length > 0 && !existingContent.endsWith("\n");
    const prefix = needsNewline ? "\n" : "";
    await appendFile(envFilePath, `${prefix}${placeholders}\n`);
  } else {
    await writeFile(envFilePath, `${placeholders}\n`);
  }
}

/**
 * Auto-pull artifact after a successful run
 */
async function autoPullArtifact(
  runOutput: string,
  artifactDir: string,
): Promise<void> {
  const serverVersion = parseArtifactVersionFromCompletion(
    runOutput,
    ARTIFACT_DIR,
  );

  if (serverVersion && existsSync(artifactDir)) {
    console.log();
    console.log(chalk.bold("Pulling updated artifact:"));
    printCommand(`cd ${ARTIFACT_DIR}`);
    printCommand(`vm0 artifact pull ${serverVersion}`);

    try {
      await execVm0Command(["artifact", "pull", serverVersion], {
        cwd: artifactDir,
        silent: true,
      });
      printCommand("cd ..");
    } catch (error) {
      console.error(chalk.red(`✗ Artifact pull failed`));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      // Don't exit - the run succeeded, pull is optional
    }
  }
}

// Create the cook command with subcommands
const cookCmd = new Command()
  .name("cook")
  .description("Quick start: prepare, compose and run agent from vm0.yaml");

// Default action for "vm0 cook [prompt]"
cookCmd
  .argument("[prompt]", "Prompt for the agent")
  .option("-y, --yes", "Skip confirmation prompts")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (
      prompt: string | undefined,
      options: {
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
        const envFilePath = path.join(cwd, ".env");
        const missingVars = checkMissingVariables(
          requiredVarNames,
          envFilePath,
        );

        if (missingVars.length > 0) {
          await generateEnvPlaceholders(missingVars, envFilePath);
          console.log();
          console.log(
            chalk.yellow(
              `⚠ Missing environment variables. Please fill in values in .env file:`,
            ),
          );
          for (const varName of missingVars) {
            console.log(chalk.yellow(`    ${varName}`));
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
              chalk.red(
                `✗ Directory not found: ${volumeConfig.name}. Create the directory and add files first.`,
              ),
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

// Subcommand: vm0 cook logs
cookCmd
  .command("logs")
  .description("View logs from the last cook run")
  .option("-a, --agent", "Show agent events (default)")
  .option("-s, --system", "Show system log")
  .option("-m, --metrics", "Show metrics")
  .option("-n, --network", "Show network logs (proxy traffic)")
  .option(
    "--since <time>",
    "Show logs since timestamp (e.g., 5m, 2h, 1d, 2024-01-15T10:30:00Z)",
  )
  .option("--tail <n>", "Show last N entries (default: 5, max: 100)")
  .option("--head <n>", "Show first N entries (max: 100)")
  .action(
    async (options: {
      agent?: boolean;
      system?: boolean;
      metrics?: boolean;
      network?: boolean;
      since?: string;
      tail?: string;
      head?: string;
    }) => {
      const state = await loadCookState();
      if (!state.lastRunId) {
        console.error(chalk.red("✗ No previous run found"));
        console.error(chalk.dim("  Run 'vm0 cook <prompt>' first"));
        process.exit(1);
      }

      // Build command args
      const args = ["logs", state.lastRunId];
      const displayArgs = [`vm0 logs ${state.lastRunId}`];

      if (options.agent) {
        args.push("--agent");
        displayArgs.push("--agent");
      }
      if (options.system) {
        args.push("--system");
        displayArgs.push("--system");
      }
      if (options.metrics) {
        args.push("--metrics");
        displayArgs.push("--metrics");
      }
      if (options.network) {
        args.push("--network");
        displayArgs.push("--network");
      }
      if (options.since) {
        args.push("--since", options.since);
        displayArgs.push(`--since ${options.since}`);
      }
      if (options.tail) {
        args.push("--tail", options.tail);
        displayArgs.push(`--tail ${options.tail}`);
      }
      if (options.head) {
        args.push("--head", options.head);
        displayArgs.push(`--head ${options.head}`);
      }

      printCommand(displayArgs.join(" "));
      await execVm0Command(args);
    },
  );

// Subcommand: vm0 cook continue <prompt>
cookCmd
  .command("continue")
  .description(
    "Continue from the last session (latest conversation and artifact)",
  )
  .argument("<prompt>", "Prompt for the continued agent")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(async (prompt: string, options: { debugNoMockClaude?: boolean }) => {
    const state = await loadCookState();
    if (!state.lastSessionId) {
      console.error(chalk.red("✗ No previous session found"));
      console.error(chalk.dim("  Run 'vm0 cook <prompt>' first"));
      process.exit(1);
    }

    const cwd = process.cwd();
    const artifactDir = path.join(cwd, ARTIFACT_DIR);

    printCommand(`vm0 run continue ${state.lastSessionId} "${prompt}"`);
    console.log();

    let runOutput: string;
    try {
      runOutput = await execVm0RunWithCapture(
        [
          "run",
          "continue",
          state.lastSessionId,
          ...(options.debugNoMockClaude ? ["--debug-no-mock-claude"] : []),
          prompt,
        ],
        { cwd },
      );
    } catch {
      // Error already displayed by vm0 run
      process.exit(1);
    }

    // Update state with new IDs
    const newIds = parseRunIdsFromOutput(runOutput);
    if (newIds.runId || newIds.sessionId || newIds.checkpointId) {
      await saveCookState({
        lastRunId: newIds.runId,
        lastSessionId: newIds.sessionId,
        lastCheckpointId: newIds.checkpointId,
      });
    }

    // Auto-pull artifact
    await autoPullArtifact(runOutput, artifactDir);
  });

// Subcommand: vm0 cook resume <prompt>
cookCmd
  .command("resume")
  .description(
    "Resume from the last checkpoint (snapshotted conversation and artifact)",
  )
  .argument("<prompt>", "Prompt for the resumed agent")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(async (prompt: string, options: { debugNoMockClaude?: boolean }) => {
    const state = await loadCookState();
    if (!state.lastCheckpointId) {
      console.error(chalk.red("✗ No previous checkpoint found"));
      console.error(chalk.dim("  Run 'vm0 cook <prompt>' first"));
      process.exit(1);
    }

    const cwd = process.cwd();
    const artifactDir = path.join(cwd, ARTIFACT_DIR);

    printCommand(`vm0 run resume ${state.lastCheckpointId} "${prompt}"`);
    console.log();

    let runOutput: string;
    try {
      runOutput = await execVm0RunWithCapture(
        [
          "run",
          "resume",
          state.lastCheckpointId,
          ...(options.debugNoMockClaude ? ["--debug-no-mock-claude"] : []),
          prompt,
        ],
        { cwd },
      );
    } catch {
      // Error already displayed by vm0 run
      process.exit(1);
    }

    // Update state with new IDs
    const newIds = parseRunIdsFromOutput(runOutput);
    if (newIds.runId || newIds.sessionId || newIds.checkpointId) {
      await saveCookState({
        lastRunId: newIds.runId,
        lastSessionId: newIds.sessionId,
        lastCheckpointId: newIds.checkpointId,
      });
    }

    // Auto-pull artifact
    await autoPullArtifact(runOutput, artifactDir);
  });

export const cookCommand = cookCmd;
