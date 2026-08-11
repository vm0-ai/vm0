import path from "node:path";

import { Command } from "commander";
import chalk from "chalk";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findPresentationRunbookResource,
  findTool,
  findTemplate,
  findVideoTemplate,
  findWebsiteTemplateResource,
  type RegistryEntry,
  type VideoTemplateRegistryEntry,
} from "@vm0/core/resource-registry";

import { getRegistryResourceDownload } from "../../../lib/api/domains/registry-resources";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { pullTarArchive } from "../shared/pull-tar-archive";

type PullableRegistryEntry = RegistryEntry | VideoTemplateRegistryEntry;

interface PullOptions {
  readonly dir: string;
}

function candidateIds(id: string): readonly string[] {
  if (id.includes(":")) {
    return [id];
  }
  return [
    `template:${id}`,
    `design-system:${id}`,
    `color-system:${id}`,
    `tool:${id}`,
    `image-style:${id}`,
    `video-template:${id}`,
  ];
}

export function findRegistryResourceForPull(
  id: string,
): PullableRegistryEntry | undefined {
  for (const candidate of candidateIds(id)) {
    const entry =
      findTemplate(candidate) ??
      findDesignSystem(candidate) ??
      findColorSystem(candidate) ??
      findTool(candidate) ??
      findImageStyle(candidate) ??
      findVideoTemplate(candidate) ??
      findPresentationRunbookResource(candidate) ??
      findWebsiteTemplateResource(candidate);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

export const zeroResourceCommand = new Command()
  .name("resource")
  .description("Pull registry resources from private R2-backed archives")
  .addCommand(
    new Command()
      .name("pull")
      .description("Download and extract a private registry resource archive")
      .argument(
        "<id>",
        "Registry resource id, such as template:html-ppt-playful-launch-runbook",
      )
      .option(
        "--dir <path>",
        "Directory to extract into",
        "./generated/resources",
      )
      .action(
        withErrorHandler(async (id: string, options: PullOptions) => {
          const entry = findRegistryResourceForPull(id);
          if (!entry) {
            throw new Error(`Unknown registry resource: ${id}`);
          }

          const archive = entry.source.archive;
          if (!archive) {
            throw new Error(
              `Registry resource ${entry.id} does not provide an R2 archive source`,
            );
          }

          console.log(chalk.dim(`Pulling ${entry.id}...`));
          const download = await getRegistryResourceDownload({
            id: entry.id,
            expectedSha256: archive.sha256,
          });
          if (download.sha256 !== archive.sha256) {
            throw new Error(
              `Resource archive digest metadata mismatch: expected ${archive.sha256}, got ${download.sha256}`,
            );
          }

          const outputDir = await pullTarArchive({
            url: download.url,
            expectedSha256: archive.sha256,
            outputDir: options.dir,
            label: "Resource archive",
          });

          console.log(chalk.green(`✓ Pulled ${entry.id}`));
          console.log(chalk.dim(`  Extracted to: ${outputDir}`));
          console.log(
            chalk.dim(
              `  Source path:  ${path.join(outputDir, entry.source.path)}`,
            ),
          );
        }),
      ),
  );
