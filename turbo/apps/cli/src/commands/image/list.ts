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

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List your custom images")
  .action(async () => {
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
      const { images } = data;

      if (images.length === 0) {
        console.log(chalk.dim("No images found."));
        console.log();
        console.log("Build your first image:");
        console.log(
          chalk.cyan("  vm0 image build --file Dockerfile --name my-image"),
        );
        return;
      }

      console.log(chalk.bold("Your images:"));
      console.log();

      // Group images by alias to determine latest versions
      const imagesByAlias = new Map<string, Image[]>();
      for (const image of images) {
        const list = imagesByAlias.get(image.alias) || [];
        list.push(image);
        imagesByAlias.set(image.alias, list);
      }

      // Find latest ready version for each alias
      const latestVersions = new Map<string, string | null>();
      for (const [alias, versions] of imagesByAlias) {
        // Already sorted by createdAt DESC from API, find first ready version
        const latestReady = versions.find((v) => v.status === "ready");
        latestVersions.set(alias, latestReady?.versionId || null);
      }

      // Table header
      console.log(
        chalk.dim(
          `${"NAME".padEnd(40)} ${"STATUS".padEnd(12)} ${"CREATED".padEnd(20)}`,
        ),
      );
      console.log(chalk.dim("-".repeat(72)));

      for (const image of images) {
        const statusColor =
          image.status === "ready"
            ? chalk.green
            : image.status === "building"
              ? chalk.yellow
              : chalk.red;

        const createdAt = new Date(image.createdAt).toLocaleString();

        // Build name with version (display first 12 chars of version ID)
        let displayName = image.alias;
        if (image.versionId) {
          const shortVersion = formatVersionIdForDisplay(image.versionId);
          displayName = `${image.alias}:${shortVersion}`;
          // Add (latest) marker if this is the latest ready version
          if (
            image.status === "ready" &&
            latestVersions.get(image.alias) === image.versionId
          ) {
            displayName = `${displayName} ${chalk.cyan("latest")}`;
          }
        }

        console.log(
          `${displayName.padEnd(40)} ${statusColor(image.status.padEnd(12))} ${createdAt.padEnd(20)}`,
        );

        if (image.status === "error" && image.errorMessage) {
          console.log(chalk.red(`  Error: ${image.errorMessage}`));
        }
      }

      console.log();
      console.log(chalk.dim(`Total: ${images.length} version(s)`));
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
