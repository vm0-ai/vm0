import { Command } from "commander";
import chalk from "chalk";
import { readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { parse as parseYaml } from "yaml";
import { validateAgentCompose } from "../lib/yaml-validator";
import { readStorageConfig } from "../lib/storage-utils";

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
 * Parse artifact version from vm0 run output
 * Looks for pattern like:
 *   Artifact:
 *     artifactName: abc12345
 * Returns the version string (8 char truncated hash)
 */
function parseArtifactVersion(
  output: string,
  artifactName: string,
  eventType: "vm0_start" | "vm0_result",
): string | null {
  // Find the section after the event marker
  const eventMarker =
    eventType === "vm0_start" ? "[vm0_start]" : "[vm0_result]";
  const eventIndex = output.indexOf(eventMarker);
  if (eventIndex === -1) return null;

  // Get the section after this event (until next event or end)
  const nextEventIndex = output.indexOf(
    eventType === "vm0_start" ? "[vm0_result]" : "[vm0_error]",
    eventIndex,
  );
  const section =
    nextEventIndex === -1
      ? output.slice(eventIndex)
      : output.slice(eventIndex, nextEventIndex);

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

export const cookCommand = new Command()
  .name("cook")
  .description("One-click agent preparation and execution from vm0.yaml")
  .argument("[prompt]", "Prompt for the agent")
  .action(async (prompt: string | undefined) => {
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

    // Step 2: Process volumes
    if (config.volumes && Object.keys(config.volumes).length > 0) {
      console.log();
      console.log(chalk.blue("Processing volumes..."));

      for (const volumeConfig of Object.values(config.volumes)) {
        const volumeDir = path.join(cwd, volumeConfig.name);
        console.log(chalk.gray(`  ${volumeConfig.name}/`));

        if (!existsSync(volumeDir)) {
          console.error(
            chalk.red(
              `    ✗ Directory not found. Create the directory and add files first.`,
            ),
          );
          process.exit(1);
        }

        try {
          // Check if already initialized
          const existingConfig = await readStorageConfig(volumeDir);
          if (!existingConfig) {
            await execVm0Command(["volume", "init"], {
              cwd: volumeDir,
              silent: true,
            });
            console.log(chalk.green(`    ✓ Initialized`));
          }

          // Push volume
          await execVm0Command(["volume", "push"], {
            cwd: volumeDir,
            silent: true,
          });
          console.log(chalk.green(`    ✓ Pushed`));
        } catch (error) {
          console.error(chalk.red(`    ✗ Failed`));
          if (error instanceof Error) {
            console.error(chalk.gray(`      ${error.message}`));
          }
          process.exit(1);
        }
      }
    }

    // Step 3: Process artifact
    console.log();
    console.log(chalk.blue("Processing artifact..."));

    const artifactDir = path.join(cwd, ARTIFACT_DIR);
    console.log(chalk.gray(`  ${ARTIFACT_DIR}/`));

    try {
      // Create directory if not exists
      if (!existsSync(artifactDir)) {
        await mkdir(artifactDir, { recursive: true });
        console.log(chalk.green(`    ✓ Created directory`));
      }

      // Check if already initialized
      const existingConfig = await readStorageConfig(artifactDir);
      if (!existingConfig) {
        await execVm0Command(["artifact", "init"], {
          cwd: artifactDir,
          silent: true,
        });
        console.log(chalk.green(`    ✓ Initialized`));
      }

      // Push artifact
      await execVm0Command(["artifact", "push"], {
        cwd: artifactDir,
        silent: true,
      });
      console.log(chalk.green(`    ✓ Pushed`));
    } catch (error) {
      console.error(chalk.red(`    ✗ Failed`));
      if (error instanceof Error) {
        console.error(chalk.gray(`      ${error.message}`));
      }
      process.exit(1);
    }

    // Step 4: Build compose
    console.log();
    console.log(chalk.blue("Building compose..."));

    try {
      await execVm0Command(["build", CONFIG_FILE], {
        cwd,
        silent: true,
      });
      console.log(chalk.green(`✓ Compose built: ${agentName}`));
    } catch (error) {
      console.error(chalk.red(`✗ Build failed`));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }

    // Step 5: Run agent (if prompt provided)
    if (prompt) {
      console.log();
      console.log(chalk.blue(`Running agent: ${agentName}`));
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

      // Step 6: Auto-pull artifact if version changed
      const startVersion = parseArtifactVersion(
        runOutput,
        ARTIFACT_DIR,
        "vm0_start",
      );
      const endVersion = parseArtifactVersion(
        runOutput,
        ARTIFACT_DIR,
        "vm0_result",
      );

      if (startVersion && endVersion && startVersion !== endVersion) {
        console.log();
        console.log(chalk.blue("Pulling updated artifact..."));

        try {
          await execVm0Command(["artifact", "pull"], {
            cwd: artifactDir,
            silent: true,
          });
          console.log(chalk.green(`✓ Artifact pulled (${endVersion})`));
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
      console.log("  Run your agent:");
      console.log(
        chalk.cyan(
          `    vm0 run ${agentName} --artifact-name ${ARTIFACT_DIR} "your prompt"`,
        ),
      );
    }
  });
