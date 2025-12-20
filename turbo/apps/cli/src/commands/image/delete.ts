import { Command } from "commander";
import chalk from "chalk";
import * as readline from "readline";
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

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a custom image or specific version")
  .argument("<name>", "Image name or name:version to delete")
  .option("-f, --force", "Skip confirmation prompt")
  .option("--all", "Delete all versions of the image")
  .action(
    async (nameArg: string, options: { force?: boolean; all?: boolean }) => {
      try {
        // Parse name:version syntax
        const colonIndex = nameArg.lastIndexOf(":");
        const hasVersion = colonIndex > 0;
        const name = hasVersion ? nameArg.slice(0, colonIndex) : nameArg;
        const versionId = hasVersion ? nameArg.slice(colonIndex + 1) : null;

        // First, list images to find the ID(s) by name
        const listResponse = await apiClient.get("/api/images");

        if (!listResponse.ok) {
          const error = await listResponse.json();
          throw new Error(
            (error as { error?: { message?: string } }).error?.message ||
              "Failed to list images",
          );
        }

        const data = (await listResponse.json()) as ListImagesResponse;

        // Find matching images
        let imagesToDelete: Image[];
        if (versionId) {
          // Delete specific version
          const image = data.images.find(
            (img) => img.alias === name && img.versionId === versionId,
          );
          if (!image) {
            console.error(chalk.red(`Image version not found: ${nameArg}`));
            process.exit(1);
          }
          imagesToDelete = [image];
        } else if (options.all) {
          // Delete all versions
          imagesToDelete = data.images.filter((img) => img.alias === name);
          if (imagesToDelete.length === 0) {
            console.error(chalk.red(`Image not found: ${name}`));
            process.exit(1);
          }
        } else {
          // Default: delete latest version only
          const matchingImages = data.images.filter(
            (img) => img.alias === name,
          );
          if (matchingImages.length === 0) {
            console.error(chalk.red(`Image not found: ${name}`));
            process.exit(1);
          }
          // Images are sorted by createdAt DESC, first ready one is latest
          const latestReady = matchingImages.find(
            (img) => img.status === "ready",
          );
          if (latestReady) {
            imagesToDelete = [latestReady];
          } else {
            // No ready version, delete the most recent
            imagesToDelete = [matchingImages[0]!];
          }
        }

        // Build confirmation message
        const confirmMsg =
          imagesToDelete.length === 1
            ? `Delete image "${imagesToDelete[0]!.alias}${imagesToDelete[0]!.versionId ? `:${imagesToDelete[0]!.versionId}` : ""}"?`
            : `Delete ${imagesToDelete.length} versions of "${name}"?`;

        // Confirmation prompt (unless --force)
        if (!options.force) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.yellow(`${confirmMsg} [y/N] `), (answer) => {
              rl.close();
              resolve(answer);
            });
          });

          if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
            console.log(chalk.gray("Cancelled."));
            return;
          }
        }

        // Delete the image(s)
        for (const image of imagesToDelete) {
          const deleteResponse = await apiClient.delete(
            `/api/images/${image.id}`,
          );

          if (!deleteResponse.ok) {
            const error = await deleteResponse.json();
            throw new Error(
              (error as { error?: { message?: string } }).error?.message ||
                "Failed to delete image",
            );
          }

          const displayName = image.versionId
            ? `${image.alias}:${image.versionId}`
            : image.alias;
          console.log(chalk.green(`Deleted image: ${displayName}`));
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
    },
  );
