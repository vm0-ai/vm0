import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../../lib/api-client";

interface Image {
  id: string;
  alias: string;
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
  .description("Delete a custom image")
  .argument("<name>", "Name of the image to delete")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (name: string, options: { force?: boolean }) => {
    try {
      // First, list images to find the ID by name
      const listResponse = await apiClient.get("/api/images");

      if (!listResponse.ok) {
        const error = await listResponse.json();
        throw new Error(
          (error as { error?: { message?: string } }).error?.message ||
            "Failed to list images",
        );
      }

      const data = (await listResponse.json()) as ListImagesResponse;
      const image = data.images.find((img) => img.alias === name);

      if (!image) {
        console.error(chalk.red(`Image not found: ${name}`));
        process.exit(1);
      }

      // Confirmation prompt (unless --force)
      if (!options.force) {
        const readline = await import("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`Delete image "${name}"? [y/N] `),
            (answer) => {
              rl.close();
              resolve(answer);
            },
          );
        });

        if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
          console.log(chalk.gray("Cancelled."));
          return;
        }
      }

      // Delete the image
      const deleteResponse = await apiClient.delete(`/api/images/${image.id}`);

      if (!deleteResponse.ok) {
        const error = await deleteResponse.json();
        throw new Error(
          (error as { error?: { message?: string } }).error?.message ||
            "Failed to delete image",
        );
      }

      console.log(chalk.green(`Deleted image: ${name}`));
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
