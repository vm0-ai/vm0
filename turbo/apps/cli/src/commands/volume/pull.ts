import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import * as tar from "tar";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { getStorageDownload } from "../../lib/api";
import { listTarFiles, removeExtraFiles } from "../../lib/utils/file-utils";
import { handleEmptyStorageResponse } from "../../lib/storage/pull-utils";

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
        console.error(chalk.dim("  Run: vm0 volume init"));
        process.exit(1);
      }

      if (versionId) {
        console.log(`Pulling volume: ${config.name} (version: ${versionId})`);
      } else {
        console.log(`Pulling volume: ${config.name}`);
      }

      // Get download URL from API
      console.log(chalk.dim("Getting download URL..."));

      const downloadInfo = await getStorageDownload({
        name: config.name,
        type: "volume",
        version: versionId,
      });

      // Handle empty volume
      if ("empty" in downloadInfo) {
        await handleEmptyStorageResponse(cwd);
        return;
      }

      const downloadUrl = downloadInfo.url;
      if (!downloadUrl) {
        throw new Error("No download URL returned");
      }

      // Download directly from S3
      console.log(chalk.dim("Downloading from S3..."));
      const s3Response = await fetch(downloadUrl);

      if (!s3Response.ok) {
        throw new Error(`S3 download failed: ${s3Response.status}`);
      }

      // Get tar.gz buffer
      const arrayBuffer = await s3Response.arrayBuffer();
      const tarBuffer = Buffer.from(arrayBuffer);

      console.log(chalk.green(`✓ Downloaded ${formatBytes(tarBuffer.length)}`));

      // Save tar.gz to temp file for processing
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm0-"));
      const tarPath = path.join(tmpDir, "volume.tar.gz");
      await fs.promises.writeFile(tarPath, tarBuffer);

      // Get remote files list for sync
      console.log(chalk.dim("Syncing local files..."));
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
      console.log(chalk.dim("Extracting files..."));
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
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
