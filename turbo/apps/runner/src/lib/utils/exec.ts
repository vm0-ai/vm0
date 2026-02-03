/**
 * Shell Command Execution Utilities
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Execute a shell command with optional sudo
 *
 * @param cmd - Command to execute
 * @param sudo - Whether to run with sudo (default: true)
 * @returns Command stdout trimmed
 * @throws Error with command and stderr on failure
 */
export async function execCommand(
  cmd: string,
  sudo: boolean = true,
): Promise<string> {
  const fullCmd = sudo ? `sudo ${cmd}` : cmd;
  try {
    const { stdout } = await execAsync(fullCmd);
    return stdout.trim();
  } catch (error) {
    const execError = error as { stderr?: string; message?: string };
    throw new Error(
      `Command failed: ${fullCmd}\n${execError.stderr || execError.message}`,
    );
  }
}
