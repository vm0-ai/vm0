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
        console.log(chalk.gray("No images found."));
        console.log();
        console.log("Build your first image:");
        console.log(
          chalk.cyan("  vm0 image build --file Dockerfile --name my-image"),
        );
        return;
      }

      console.log(chalk.bold("Your images:"));
      console.log();

      // Table header
      console.log(
        chalk.gray(
          `${"NAME".padEnd(30)} ${"STATUS".padEnd(12)} ${"CREATED".padEnd(20)}`,
        ),
      );
      console.log(chalk.gray("-".repeat(62)));

      for (const image of images) {
        const statusColor =
          image.status === "ready"
            ? chalk.green
            : image.status === "building"
              ? chalk.yellow
              : chalk.red;

        const createdAt = new Date(image.createdAt).toLocaleString();

        console.log(
          `${image.alias.padEnd(30)} ${statusColor(image.status.padEnd(12))} ${createdAt.padEnd(20)}`,
        );

        if (image.status === "error" && image.errorMessage) {
          console.log(chalk.red(`  Error: ${image.errorMessage}`));
        }
      }

      console.log();
      console.log(chalk.gray(`Total: ${images.length} image(s)`));
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
