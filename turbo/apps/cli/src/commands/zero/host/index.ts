import { Command } from "commander";
import chalk from "chalk";
import {
  hostedArtifactKindSchema,
  type HostedArtifactKind,
} from "@vm0/api-contracts/contracts/zero-host";
import { withErrorHandler } from "../../../lib/command";
import { publishStaticSite } from "../../../lib/host/publish-static-site";
import { cloneHostedSiteCommand } from "./clone";
import { versionsHostedSiteCommand } from "./versions";

interface HostOptions {
  readonly site?: string;
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
  .description("Publish and inspect owned static hosted sites")
  .argument("<dir>", "Static build directory, for example ./dist")
  .option("--site <slug>", "Public site slug, e.g. my-product-demo")
  .option("--slug-suffix <suffix>", "Reuse a legacy generated site URL suffix")
  .option(
    "--artifact-kind <kind>",
    "Artifact kind to record for this hosted deployment",
    parseArtifactKind,
  )
  .option("--spa", "Serve unknown HTML navigation paths from index.html")
  .option("--json", "Output only the final result as JSON")
  .addCommand(cloneHostedSiteCommand)
  .addCommand(versionsHostedSiteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Publish a Vite build:  zero host ./dist --site my-product-demo --spa
  Publish next version:  zero host ./dist --site my-product-demo --spa
  Reuse a legacy URL:    zero host ./dist --site my-product-demo --slug-suffix release-01 --spa
  List site versions:    zero host versions my-product-demo
  Clone a hosted site:   zero host clone my-product-demo ./site
  Machine readable:     zero host ./dist --site my-product-demo --spa --json

Notes:
  - Authenticates via ZERO_TOKEN (publish requires host:write; clone requires host:read)
  - With hosted artifact versions enabled, reusing --site publishes behind the same alias
  - Otherwise, reuse both --site and --slug-suffix to keep a legacy URL
  - The directory must include index.html
  - Local HTML/CSS asset references must point at files inside the directory`,
  )
  .action(
    withErrorHandler(async (dir: string, options: HostOptions) => {
      if (!options.site) {
        throw new Error("--site is required when publishing a hosted site");
      }
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

      console.log(chalk.green("✓ Hosted site deployed"));
      console.log(chalk.dim(`  Site: ${result.publicSlug}`));
      if (result.deploymentVersion !== undefined) {
        console.log(chalk.dim(`  Version: v${result.deploymentVersion}`));
      }
      if (result.artifactUrl) {
        console.log(`  Artifact: ${result.artifactUrl}`);
      }
      if (result.aliasUrl) {
        const target =
          result.isActive === false &&
          result.activeDeploymentVersion !== undefined
            ? `remains on v${result.activeDeploymentVersion}`
            : `v${result.deploymentVersion ?? "?"}`;
        console.log(`  Alias: ${result.aliasUrl} → ${target}`);
      }
      console.log(chalk.dim(`  Deployment: ${result.deploymentId}`));
      console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
      if (!result.aliasUrl) {
        console.log(`  URL: ${result.url}`);
      }
    }),
  );
