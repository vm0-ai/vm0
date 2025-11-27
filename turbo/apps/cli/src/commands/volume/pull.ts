import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import AdmZip from "adm-zip";
import { readStorageConfig } from "../../lib/storage-utils";
import { apiClient } from "../../lib/api-client";

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

      let url = `/api/storages?name=${encodeURIComponent(config.name)}`;
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

      // Get zip buffer
      const arrayBuffer = await response.arrayBuffer();
      const zipBuffer = Buffer.from(arrayBuffer);

      console.log(chalk.green(`✓ Downloaded ${formatBytes(zipBuffer.length)}`));

      // Extract zip
      console.log(chalk.gray("Extracting files..."));
      const zip = new AdmZip(zipBuffer);
      const zipEntries = zip.getEntries();

      let extractedCount = 0;
      for (const entry of zipEntries) {
        if (!entry.isDirectory) {
          const targetPath = path.join(cwd, entry.entryName);

          // Create directory if needed
          const dir = path.dirname(targetPath);
          await fs.promises.mkdir(dir, { recursive: true });

          // Extract file
          const data = entry.getData();
          await fs.promises.writeFile(targetPath, data);
          extractedCount++;
        }
      }

      console.log(chalk.green(`✓ Extracted ${extractedCount} files`));
    } catch (error) {
      console.error(chalk.red("✗ Pull failed"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
