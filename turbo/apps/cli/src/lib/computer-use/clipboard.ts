import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Read text content from the macOS clipboard using pbpaste.
 */
export async function readClipboard(): Promise<string> {
  const { stdout } = await execFileAsync("pbpaste");
  return stdout;
}

/**
 * Write text content to the macOS clipboard using pbcopy.
 */
export async function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pbcopy exited with code ${code}`));
      }
    });
    proc.stdin.end(text);
  });
}
