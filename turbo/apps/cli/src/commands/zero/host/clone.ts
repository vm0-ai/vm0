import { Command } from "commander";
import chalk from "chalk";

import { withErrorHandler } from "../../../lib/command";
import {
  cloneHostedSite,
  publicSlugFromSite,
} from "../../../lib/host/clone-hosted-site";
import { formatBytes } from "../../../lib/utils/file-utils";

interface CloneOptions {
  readonly json?: boolean;
}

function jsonOption(options: CloneOptions, command: Command): boolean {
  const parentOptions = command.parent?.opts<CloneOptions>();
  return Boolean(options.json || parentOptions?.json);
}

export const cloneHostedSiteCommand = new Command()
  .name("clone")
  .description("Clone an owned hosted site's active files to a local directory")
  .argument("<site>", "Hosted site public slug or URL")
  .argument("[destination]", "Destination directory (default: public slug)")
  .option("--json", "Output only the final result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Clone by public slug:  zero host clone my-site-a1b2c3d4-release-01
  Clone by hosted URL:   zero host clone https://my-site-a1b2c3d4-release-01.sites.example.com ./site
  Machine readable:      zero host clone my-site-a1b2c3d4-release-01 --json

Notes:
  - Authenticates via ZERO_TOKEN (requires host:read capability)
  - Only hosted sites owned by the active org can be cloned
  - Downloads files directly from R2 and verifies size/hash
  - The destination directory must be empty or not exist`,
  )
  .action(
    withErrorHandler(
      async (
        site: string,
        destination: string | undefined,
        options: CloneOptions,
        command: Command,
      ) => {
        const json = jsonOption(options, command);
        const targetDir = destination ?? publicSlugFromSite(site);
        const result = await cloneHostedSite({
          site,
          destination: targetDir,
          onProgress: json
            ? undefined
            : (progress) => {
                if (progress.phase === "checking") {
                  console.log(chalk.dim("Checking hosted site..."));
                  return;
                }
                if (progress.phase === "creating") {
                  console.log(
                    chalk.dim(
                      `Preparing ${progress.fileCount?.toLocaleString() ?? 0} files...`,
                    ),
                  );
                  return;
                }
                console.log(chalk.dim(`Downloading ${progress.path}`));
              },
        });

        if (json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green("✓ Hosted site cloned"));
        console.log(chalk.dim(`  Site: ${result.publicSlug}`));
        console.log(chalk.dim(`  Deployment: ${result.deploymentId}`));
        console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
        console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
        console.log(chalk.dim(`  Location: ${result.destination}/`));
        console.log(`  URL: ${result.url}`);
      },
    ),
  );
