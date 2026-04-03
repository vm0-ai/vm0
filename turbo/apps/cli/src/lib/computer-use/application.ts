import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Open or activate a macOS application by name or bundle ID.
 * Detects bundle IDs by the presence of dots (e.g., com.apple.Safari).
 */
export async function openApplication(nameOrBundleId: string): Promise<void> {
  const isBundleId = nameOrBundleId.includes(".");
  const flag = isBundleId ? "-b" : "-a";
  await execFileAsync("open", [flag, nameOrBundleId]);
}
