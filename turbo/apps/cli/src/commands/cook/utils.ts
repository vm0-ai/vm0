import chalk from "chalk";
import { spawn } from "child_process";
import { existsSync } from "fs";

export const CONFIG_FILE = "vm0.yaml";
export const ARTIFACT_DIR = "artifact";

/**
 * Print a command hint for tutorial output
 */
export function printCommand(cmd: string): void {
  console.log(chalk.dim(`> ${cmd}`));
}

/**
 * Execute a vm0 command in a subprocess
 * Returns stdout on success, throws on failure with stderr
 *
 * @param options.silent - If true, capture stdout/stderr (no output to terminal)
 */
export function execVm0Command(
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
export function execVm0RunWithCapture(
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
 * Auto-pull artifact after a successful run
 */
export async function autoPullArtifact(
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
