import { Command } from "commander";
import chalk from "chalk";
import {
  hostedArtifactKindSchema,
  type HostedArtifactKind,
} from "@vm0/api-contracts/contracts/zero-host";
import { withErrorHandler } from "../../../lib/command";
import { publishStaticSite } from "../../../lib/host/publish-static-site";

interface HostOptions {
  readonly site: string;
  readonly slugSuffix?: string;
  readonly artifactKind?: HostedArtifactKind;
  readonly spa?: boolean;
  readonly json?: boolean;
}

function parseArtifactKind(value: string): HostedArtifactKind {
  return hostedArtifactKindSchema.parse(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const zeroHostCommand = new Command()
  .name("host")
  .description("Publish a built static site and print its public URL")
  .argument("<dir>", "Static build directory, for example ./dist")
  .requiredOption("--site <slug>", "Public site slug, e.g. my-product-demo")
  .option("--slug-suffix <suffix>", "Reuse a generated site URL suffix")
  .option(
    "--artifact-kind <kind>",
    "Artifact kind to record for this hosted deployment",
    parseArtifactKind,
  )
  .option("--spa", "Serve unknown HTML navigation paths from index.html")
  .option("--json", "Output only the final result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Publish a Vite build:  zero host ./dist --site my-product-demo --spa
  Redeploy a URL:       zero host ./dist --site my-product-demo --slug-suffix a1b2c3d4 --spa
  Machine readable:     zero host ./dist --site my-product-demo --spa --json

Notes:
  - Authenticates via ZERO_TOKEN (requires host:write capability)
  - Reusing both --site and --slug-suffix keeps the same URL
  - The directory must include index.html
  - Local HTML/CSS asset references must point at files inside the directory`,
  )
  .action(
    withErrorHandler(async (dir: string, options: HostOptions) => {
      const result = await publishStaticSite({
        dir,
        site: options.site,
        slugSuffix: options.slugSuffix,
        artifactKind: options.artifactKind,
        spaFallback: Boolean(options.spa),
        onProgress: options.json
          ? undefined
          : (progress) => {
              if (progress.phase === "preparing") {
                console.log(
                  chalk.dim(`Preparing ${progress.fileCount} files...`),
                );
                return;
              }
              console.log(chalk.dim(`Uploading ${progress.path}`));
            },
      });

      if (options.json) {
        console.log(JSON.stringify(result));
        return;
      }

      console.log(chalk.green("✓ Hosted site ready"));
      console.log(chalk.dim(`  Site: ${result.publicSlug}`));
      console.log(chalk.dim(`  Deployment: ${result.deploymentId}`));
      console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
      console.log(`  URL: ${result.url}`);
    }),
  );
