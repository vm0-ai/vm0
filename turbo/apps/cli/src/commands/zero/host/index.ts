import { readFile } from "node:fs/promises";

import { Command } from "commander";
import chalk from "chalk";
import { completeHostedSite, prepareHostedSite } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { scanStaticSite } from "../../../lib/host/static-site";

interface HostOptions {
  readonly site: string;
  readonly spa?: boolean;
  readonly json?: boolean;
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
  .option("--spa", "Serve unknown HTML navigation paths from index.html")
  .option("--json", "Output only the final result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Publish a Vite build:  zero host ./dist --site my-product-demo --spa
  Machine readable:     zero host ./dist --site my-product-demo --spa --json

Notes:
  - Authenticates via ZERO_TOKEN (requires host:write capability)
  - The directory must include index.html
  - Local HTML/CSS asset references must point at files inside the directory`,
  )
  .action(
    withErrorHandler(async (dir: string, options: HostOptions) => {
      const scan = await scanStaticSite(dir);
      const totalSize = scan.files.reduce((sum, file) => {
        return sum + file.size;
      }, 0);

      if (!options.json) {
        console.log(chalk.dim(`Preparing ${scan.files.length} files...`));
      }

      const prepared = await prepareHostedSite({
        site: options.site,
        spaFallback: Boolean(options.spa),
        files: scan.files.map((file) => {
          return {
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            contentType: file.contentType,
            immutable: file.immutable,
          };
        }),
      });

      const uploadByPath = new Map(
        prepared.uploads.map((upload) => {
          return [upload.path, upload.uploadUrl];
        }),
      );

      for (const file of scan.files) {
        const uploadUrl = uploadByPath.get(file.path);
        if (!uploadUrl) {
          throw new Error(`Missing upload URL for ${file.path}`);
        }
        if (!options.json) {
          console.log(chalk.dim(`Uploading ${file.path}`));
        }
        const bytes = await readFile(file.absolutePath);
        const response = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.contentType },
          body: new Uint8Array(bytes),
        });
        if (!response.ok) {
          throw new Error(
            `Failed to upload ${file.path} (HTTP ${response.status})`,
          );
        }
      }

      const completed = await completeHostedSite(prepared.deploymentId);

      if (options.json) {
        console.log(
          JSON.stringify({
            siteId: completed.siteId,
            deploymentId: completed.deploymentId,
            publicSlug: completed.publicSlug,
            url: completed.url,
            fileCount: scan.files.length,
            size: totalSize,
          }),
        );
        return;
      }

      console.log(chalk.green("✓ Hosted site ready"));
      console.log(chalk.dim(`  Site: ${completed.publicSlug}`));
      console.log(chalk.dim(`  Deployment: ${completed.deploymentId}`));
      console.log(chalk.dim(`  Files: ${scan.files.length.toLocaleString()}`));
      console.log(chalk.dim(`  Size: ${formatBytes(totalSize)}`));
      console.log(`  URL: ${completed.url}`);
    }),
  );
