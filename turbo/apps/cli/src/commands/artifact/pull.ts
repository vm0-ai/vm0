import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import * as tar from "tar";
import { readStorageConfig } from "../../lib/storage/storage-utils";
import { getStorageDownload } from "../../lib/api";
import {
  formatBytes,
  listTarFiles,
  removeExtraFiles,
} from "../../lib/utils/file-utils";
import { handleEmptyStorageResponse } from "../../lib/storage/pull-utils";

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

      const downloadInfo = await getStorageDownload({
        name: config.name,
        type: "artifact",
        version: versionId,
      });

      // Handle empty artifact
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
