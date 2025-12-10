import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import * as tar from "tar";
import { readStorageConfig } from "../../lib/storage-utils";
import { apiClient } from "../../lib/api-client";
import { listTarFiles, removeExtraFiles } from "../../lib/file-utils";

/**
 * Format bytes to human-readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export const pullCommand = new Command()
  .name("pull")
  .description("Pull cloud files to local directory")
  .argument("[versionId]", "Version ID to pull (default: latest)")
  .action(async (versionId?: string) => {
    try {
      const cwd = process.cwd();

      // Read storage config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No volume initialized in this directory"));
        console.error(chalk.gray("  Run: vm0 volume init"));
        process.exit(1);
      }

      if (versionId) {
        console.log(
          chalk.cyan(`Pulling volume: ${config.name} (version: ${versionId})`),
        );
      } else {
        console.log(chalk.cyan(`Pulling volume: ${config.name}`));
      }

      // Download from API
      console.log(chalk.gray("Downloading..."));

      let url = `/api/storages?name=${encodeURIComponent(config.name)}&type=volume`;
      if (versionId) {
        url += `&version=${encodeURIComponent(versionId)}`;
      }

      const response = await apiClient.get(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.error(chalk.red(`✗ Volume "${config.name}" not found`));
          console.error(
            chalk.gray(
              "  Make sure the volume name is correct in .vm0/storage.yaml",
            ),
          );
          console.error(
            chalk.gray("  Or push the volume first with: vm0 volume push"),
          );
        } else {
          const error = (await response.json()) as { error: string };
          throw new Error(error.error || "Download failed");
        }
        process.exit(1);
      }

      // Get tar.gz buffer
      const arrayBuffer = await response.arrayBuffer();
      const tarBuffer = Buffer.from(arrayBuffer);

      console.log(chalk.green(`✓ Downloaded ${formatBytes(tarBuffer.length)}`));

      // Save tar.gz to temp file for processing
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm0-"));
      const tarPath = path.join(tmpDir, "volume.tar.gz");
      await fs.promises.writeFile(tarPath, tarBuffer);

      // Get remote files list for sync
      console.log(chalk.gray("Syncing local files..."));
      const remoteFiles = await listTarFiles(tarPath);
      const remoteFilesSet = new Set(
        remoteFiles.map((f) => f.replace(/\\/g, "/")),
      );

      // Remove local files not in remote
      const removedCount = await removeExtraFiles(cwd, remoteFilesSet);
      if (removedCount > 0) {
        console.log(
          chalk.green(`✓ Removed ${removedCount} files not in remote`),
        );
      }

      // Extract tar.gz
      console.log(chalk.gray("Extracting files..."));
      await tar.extract({
        file: tarPath,
        cwd: cwd,
        gzip: true,
      });

      // Clean up temp files
      await fs.promises.unlink(tarPath);
      await fs.promises.rmdir(tmpDir);

      console.log(chalk.green(`✓ Extracted ${remoteFiles.length} files`));
    } catch (error) {
      console.error(chalk.red("✗ Pull failed"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
