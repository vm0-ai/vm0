import chalk from "chalk";
import { removeExtraFiles } from "./file-utils";

/**
 * Result of handling an empty storage response (HTTP 204).
 */
export interface EmptyStorageResult {
  removedCount: number;
}

/**
 * Handle empty storage response (HTTP 204 No Content).
 * Syncs local directory to empty state by removing all tracked files.
 *
 * @param cwd - Current working directory
 * @returns Result with count of removed files
 */
export async function handleEmptyStorageResponse(
  cwd: string,
): Promise<EmptyStorageResult> {
  console.log(chalk.dim("Syncing local files..."));

  // Sync to empty state - remove all local files
  const removedCount = await removeExtraFiles(cwd, new Set());

  if (removedCount > 0) {
    console.log(chalk.green(`✓ Removed ${removedCount} files not in remote`));
  }

  console.log(chalk.green("✓ Synced (0 files)"));

  return { removedCount };
}
