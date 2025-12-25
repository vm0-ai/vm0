import { Command } from "commander";
import chalk from "chalk";
import { readFile, mkdir, writeFile, appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { parse as parseYaml } from "yaml";
import { config as dotenvConfig } from "dotenv";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { validateAgentCompose } from "../lib/yaml-validator";
import { readStorageConfig } from "../lib/storage-utils";
import { checkAndUpgrade } from "../lib/update-checker";

declare const __CLI_VERSION__: string;

interface VolumeConfig {
  name: string;
  version: string;
}

interface AgentConfig {
  description?: string;
  provider: string;
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

const CONFIG_FILE = "vm0.yaml";
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
 */
function execVm0Command(
  args: string[],
  options: { cwd?: string; silent?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("vm0", args, {
      cwd: options.cwd,
      stdio: options.silent ? "pipe" : ["inherit", "inherit", "inherit"],
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
 * Extract all required variable names from compose config
 * Returns unique names from both vars and secrets references
 */
function extractRequiredVarNames(config: AgentComposeConfig): string[] {
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
function checkMissingVariables(
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
async function generateEnvPlaceholders(
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

export const cookCommand = new Command()
  .name("cook")
  .description("One-click agent preparation and execution from vm0.yaml")
  .argument("[prompt]", "Prompt for the agent")
  .action(async (prompt: string | undefined) => {
    // Step 0: Check for updates and auto-upgrade if needed
    const shouldExit = await checkAndUpgrade(__CLI_VERSION__, prompt);
    if (shouldExit) {
      process.exit(0);
    }

    const cwd = process.cwd();

    // Step 1: Read and parse config
    console.log(chalk.blue(`Reading config: ${CONFIG_FILE}`));

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
        console.error(chalk.gray(`  ${error.message}`));
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
    const volumeCount = config.volumes ? Object.keys(config.volumes).length : 0;

    console.log(
      chalk.green(`✓ Config validated: 1 agent, ${volumeCount} volume(s)`),
    );

    // Step 1.5: Check for missing environment variables
    const requiredVarNames = extractRequiredVarNames(config);
    if (requiredVarNames.length > 0) {
      const envFilePath = path.join(cwd, ".env");
      const missingVars = checkMissingVariables(requiredVarNames, envFilePath);

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
      console.log(chalk.blue("Processing volumes:"));

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
            printCommand("vm0 volume init");
            await execVm0Command(["volume", "init"], {
              cwd: volumeDir,
              silent: true,
            });
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
            console.error(chalk.gray(`  ${error.message}`));
          }
          process.exit(1);
        }
      }
    }

    // Step 3: Process artifact
    console.log();
    console.log(chalk.blue("Processing artifact:"));

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
        printCommand("vm0 artifact init");
        await execVm0Command(["artifact", "init"], {
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
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }

    // Step 4: Compose agent
    console.log();
    console.log(chalk.blue("Composing agent:"));
    printCommand(`vm0 compose ${CONFIG_FILE}`);

    try {
      await execVm0Command(["compose", CONFIG_FILE], {
        cwd,
        silent: true,
      });
    } catch (error) {
      console.error(chalk.red(`✗ Compose failed`));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }

    // Step 5: Run agent (if prompt provided)
    if (prompt) {
      console.log();
      console.log(chalk.blue("Running agent:"));
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
          prompt,
        ];
        runOutput = await execVm0RunWithCapture(runArgs, { cwd });
      } catch {
        // Error already displayed by vm0 run
        process.exit(1);
      }

      // Step 6: Auto-pull artifact if run completed with artifact changes
      // Check if completion output shows an artifact version
      const serverVersion = parseArtifactVersionFromCompletion(
        runOutput,
        ARTIFACT_DIR,
      );

      if (serverVersion) {
        console.log();
        console.log(chalk.blue("Pulling updated artifact:"));
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
            console.error(chalk.gray(`  ${error.message}`));
          }
          // Don't exit - the run succeeded, pull is optional
        }
      }
    } else {
      console.log();
      console.log("To run your agent:");
      printCommand(
        `vm0 run ${agentName} --artifact-name ${ARTIFACT_DIR} "your prompt"`,
      );
    }
  });
