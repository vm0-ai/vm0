import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { formatVersionIdForDisplay } from "@vm0/core";
import { apiClient } from "../../lib/api-client";
import { validateDockerfile } from "../../lib/dockerfile-validator";

interface BuildStatusResponse {
  status: "building" | "ready" | "error";
  logs: string[];
  logsOffset: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const buildCommand = new Command()
  .name("build")
  .description("Build a custom image from a Dockerfile")
  .requiredOption("-f, --file <path>", "Path to Dockerfile")
  .requiredOption("-n, --name <name>", "Name for the image")
  .option("--delete-existing", "Delete existing image before building")
  .action(
    async (options: {
      file: string;
      name: string;
      deleteExisting?: boolean;
    }) => {
      const { file, name, deleteExisting } = options;

      // Validate file exists
      if (!existsSync(file)) {
        console.error(chalk.red(`✗ Dockerfile not found: ${file}`));
        process.exit(1);
      }

      // Validate name format: 3-64 chars, alphanumeric and hyphens, start/end with alphanumeric
      const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;
      if (!nameRegex.test(name)) {
        console.error(
          chalk.red(
            "✗ Invalid name format. Must be 3-64 characters, letters, numbers, and hyphens only.",
          ),
        );
        process.exit(1);
      }

      // Check reserved prefix
      if (name.startsWith("vm0-")) {
        console.error(
          chalk.red(
            '✗ Invalid name. Cannot start with "vm0-" (reserved prefix).',
          ),
        );
        process.exit(1);
      }

      try {
        // Get user's scope for output
        const scope = await apiClient.getScope();

        // Read Dockerfile content
        const dockerfile = await readFile(file, "utf8");

        // Validate Dockerfile instructions
        const validation = validateDockerfile(dockerfile);
        if (!validation.valid) {
          console.error(chalk.red("✗ Dockerfile validation failed\n"));
          for (const error of validation.errors) {
            console.error(chalk.red(`  ${error}`));
          }
          console.error();
          console.error(
            chalk.yellow(
              "  vm0 image build only supports FROM and RUN instructions.",
            ),
          );
          console.error(
            chalk.yellow(
              "  The purpose is to pre-install environment dependencies.",
            ),
          );
          process.exit(1);
        }

        console.log(chalk.bold(`Building image: ${scope.slug}/${name}`));
        console.log();

        // Start build
        const buildInfo = await apiClient.createImage({
          dockerfile,
          alias: name,
          deleteExisting,
        });
        const { imageId, buildId, versionId } = buildInfo;

        console.log(chalk.dim(`  Build ID: ${buildId}`));
        console.log();

        // Poll for status
        let logsOffset = 0;
        let status: "building" | "ready" | "error" = "building";

        while (status === "building") {
          const statusResponse = await apiClient.get(
            `/api/images/${imageId}/builds/${buildId}?logsOffset=${logsOffset}`,
          );

          if (!statusResponse.ok) {
            const error = await statusResponse.json();
            throw new Error(
              (error as { error?: { message?: string } }).error?.message ||
                "Failed to get build status",
            );
          }

          const statusData =
            (await statusResponse.json()) as BuildStatusResponse;

          // Print new logs
          for (const log of statusData.logs) {
            console.log(chalk.dim(`  ${log}`));
          }

          logsOffset = statusData.logsOffset;
          status = statusData.status;

          if (status === "building") {
            await sleep(2000);
          }
        }

        console.log();

        if (status === "ready") {
          const shortVersion = formatVersionIdForDisplay(versionId);
          console.log(
            chalk.green(`✓ Image built: ${scope.slug}/${name}:${shortVersion}`),
          );
        } else {
          console.error(chalk.red(`✗ Build failed`));
          process.exit(1);
        }
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else {
            console.error(chalk.red(`✗ ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
