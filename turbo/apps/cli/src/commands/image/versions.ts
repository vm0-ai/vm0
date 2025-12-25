import { Command } from "commander";
import chalk from "chalk";
import { formatVersionIdForDisplay } from "@vm0/core";
import { apiClient } from "../../lib/api-client";

interface Image {
  id: string;
  alias: string;
  versionId: string | null;
  status: "building" | "ready" | "error";
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListImagesResponse {
  images: Image[];
}

export const versionsCommand = new Command()
  .name("versions")
  .description("List all versions of an image")
  .argument("<name>", "Name of the image")
  .action(async (name: string) => {
    try {
      const response = await apiClient.get("/api/images");

      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          (error as { error?: { message?: string } }).error?.message ||
            "Failed to list images",
        );
      }

      const data = (await response.json()) as ListImagesResponse;

      // Filter to just versions of this image, already sorted by createdAt DESC
      const versions = data.images.filter((img) => img.alias === name);

      if (versions.length === 0) {
        console.error(chalk.red(`Image not found: ${name}`));
        process.exit(1);
      }

      // Find latest ready version
      const latestReady = versions.find((v) => v.status === "ready");
      const latestVersionId = latestReady?.versionId || null;

      console.log(chalk.bold(`Versions of ${name}:`));
      console.log();

      // Table header
      console.log(
        chalk.dim(
          `${"VERSION".padEnd(20)} ${"STATUS".padEnd(12)} ${"CREATED".padEnd(24)}`,
        ),
      );
      console.log(chalk.dim("-".repeat(56)));

      for (const version of versions) {
        const statusColor =
          version.status === "ready"
            ? chalk.green
            : version.status === "building"
              ? chalk.yellow
              : chalk.red;

        const createdAt = new Date(version.createdAt).toLocaleString();

        // Build version display (show first 12 chars of version ID)
        let versionDisplay = version.versionId
          ? formatVersionIdForDisplay(version.versionId)
          : "(legacy)";
        if (
          version.status === "ready" &&
          version.versionId === latestVersionId
        ) {
          versionDisplay = `${versionDisplay} ${chalk.cyan("latest")}`;
        }

        console.log(
          `${versionDisplay.padEnd(20)} ${statusColor(version.status.padEnd(12))} ${createdAt.padEnd(24)}`,
        );

        if (version.status === "error" && version.errorMessage) {
          console.log(chalk.red(`  Error: ${version.errorMessage}`));
        }
      }

      console.log();
      console.log(chalk.dim(`Total: ${versions.length} version(s)`));
      console.log();
      console.log(chalk.dim("Usage:"));
      console.log(chalk.dim(`  image: "${name}"              # uses latest`));
      if (latestVersionId) {
        const shortVersion = formatVersionIdForDisplay(latestVersionId);
        console.log(
          chalk.dim(
            `  image: "${name}:${shortVersion}"   # pin to specific version`,
          ),
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
      } else {
        console.error(chalk.red("An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
