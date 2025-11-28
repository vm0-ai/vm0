import { Command } from "commander";
import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import AdmZip from "adm-zip";
import { readStorageConfig } from "../../lib/storage-utils";
import { apiClient } from "../../lib/api-client";

/**
 * Get all files in directory recursively, excluding .vm0/
 */
async function getAllFiles(
  dirPath: string,
  baseDir: string = dirPath,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Skip .vm0 directory
    if (relativePath.startsWith(".vm0")) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

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

export const pushCommand = new Command()
  .name("push")
  .description("Push local files to cloud artifact")
  .action(async () => {
    try {
      const cwd = process.cwd();

      // Read config
      const config = await readStorageConfig(cwd);
      if (!config) {
        console.error(chalk.red("✗ No artifact initialized in this directory"));
        console.error(chalk.gray("  Run: vm0 artifact init"));
        process.exit(1);
      }

      if (config.type !== "artifact") {
        console.error(
          chalk.red(
            `✗ This directory is initialized as a volume, not an artifact`,
          ),
        );
        console.error(chalk.gray("  Use: vm0 volume push"));
        process.exit(1);
      }

      console.log(chalk.cyan(`Pushing artifact: ${config.name}`));

      // Get all files
      console.log(chalk.gray("Collecting files..."));
      const files = await getAllFiles(cwd);

      if (files.length === 0) {
        console.log(chalk.yellow("No files to upload"));
        return;
      }

      // Calculate total size
      let totalSize = 0;
      for (const file of files) {
        const stats = await fs.promises.stat(file);
        totalSize += stats.size;
      }

      console.log(
        chalk.gray(`Found ${files.length} files (${formatBytes(totalSize)})`),
      );

      // Create zip file
      console.log(chalk.gray("Compressing files..."));
      const zip = new AdmZip();

      for (const file of files) {
        const relativePath = path.relative(cwd, file);
        zip.addLocalFile(file, path.dirname(relativePath));
      }

      const zipBuffer = zip.toBuffer();
      console.log(
        chalk.green(`✓ Compressed to ${formatBytes(zipBuffer.length)}`),
      );

      // Upload to API
      console.log(chalk.gray("Uploading..."));

      const formData = new FormData();
      formData.append("name", config.name);
      formData.append("type", "artifact");
      formData.append(
        "file",
        new Blob([zipBuffer], { type: "application/zip" }),
        "artifact.zip",
      );

      const response = await apiClient.post("/api/storages", {
        body: formData,
      });

      if (!response.ok) {
        const error = (await response.json()) as { error: string };
        throw new Error(error.error || "Upload failed");
      }

      const result = (await response.json()) as {
        name: string;
        versionId: string;
        size: number;
        fileCount: number;
        deduplicated?: boolean;
      };

      // Display short version (8 characters) by default
      const shortVersion = result.versionId.slice(0, 8);

      if (result.deduplicated) {
        console.log(chalk.green("✓ Content unchanged (deduplicated)"));
      } else {
        console.log(chalk.green("✓ Upload complete"));
      }
      console.log(chalk.gray(`  Version: ${shortVersion}`));
      console.log(chalk.gray(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.gray(`  Size: ${formatBytes(result.size)}`));
    } catch (error) {
      console.error(chalk.red("✗ Push failed"));
      if (error instanceof Error) {
        console.error(chalk.gray(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
