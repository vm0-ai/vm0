import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import * as tar from "tar";
import { readStorageConfig } from "../../lib/storage-utils";
import { apiClient, type ApiError } from "../../lib/api-client";
import { listTarFiles, removeExtraFiles } from "../../lib/file-utils";
import { handleEmptyStorageResponse } from "../../lib/pull-utils";

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

/**
 * Download response from /api/storages/download
 */
interface DownloadResponse {
  url?: string;
  empty?: boolean;
  versionId: string;
  fileCount: number;
  size: number;
}

export const pullCommand = new Command()
  .name("pull")
  .description("Pull cloud artifact to local directory")
  .argument("[versionId]", "Version ID to pull (default: latest)")
  .action(async (versionId?: string) => {
    try {
      const cwd = process.cwd();

      // Read config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No artifact initialized in this directory"));
        console.error(chalk.dim("  Run: vm0 artifact init"));
        process.exit(1);
      }

      if (config.type !== "artifact") {
        console.error(
          chalk.red(
            `✗ This directory is initialized as a volume, not an artifact`,
          ),
        );
        console.error(chalk.dim("  Use: vm0 volume pull"));
        process.exit(1);
      }

      if (versionId) {
        console.log(`Pulling artifact: ${config.name} (version: ${versionId})`);
      } else {
        console.log(`Pulling artifact: ${config.name}`);
      }

      // Get download URL from API
      console.log(chalk.dim("Getting download URL..."));

      let url = `/api/storages/download?name=${encodeURIComponent(config.name)}&type=artifact`;
      if (versionId) {
        url += `&version=${encodeURIComponent(versionId)}`;
      }

      const response = await apiClient.get(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.error(chalk.red(`✗ Artifact "${config.name}" not found`));
          console.error(
            chalk.dim(
              "  Make sure the artifact name is correct in .vm0/storage.yaml",
            ),
          );
          console.error(
            chalk.dim("  Or push the artifact first with: vm0 artifact push"),
          );
        } else {
          const error = (await response.json()) as ApiError;
          throw new Error(error.error?.message || "Download failed");
        }
        process.exit(1);
      }

      const downloadInfo = (await response.json()) as DownloadResponse;

      // Handle empty artifact
      if (downloadInfo.empty) {
        await handleEmptyStorageResponse(cwd);
        return;
      }

      if (!downloadInfo.url) {
        throw new Error("No download URL returned");
      }

      // Download directly from S3
      console.log(chalk.dim("Downloading from S3..."));
      const s3Response = await fetch(downloadInfo.url);

      if (!s3Response.ok) {
        throw new Error(`S3 download failed: ${s3Response.status}`);
      }

      // Get tar.gz buffer
      const arrayBuffer = await s3Response.arrayBuffer();
      const tarBuffer = Buffer.from(arrayBuffer);

      console.log(chalk.green(`✓ Downloaded ${formatBytes(tarBuffer.length)}`));

      // Save tar.gz to temp file for processing
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm0-"));
      const tarPath = path.join(tmpDir, "artifact.tar.gz");
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
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
