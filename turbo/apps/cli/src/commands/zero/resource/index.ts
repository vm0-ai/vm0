import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import chalk from "chalk";
import * as tar from "tar";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findTool,
  findTemplate,
  findVideoTemplate,
  type RegistryEntry,
  type VideoTemplateRegistryEntry,
} from "@vm0/core/resource-registry";

import { getRegistryResourceDownload } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

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
      findVideoTemplate(candidate);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

function isSafeTarPath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/gu, "/");
  return (
    !path.isAbsolute(normalized) &&
    !normalized.split("/").some((segment) => {
      return segment === "..";
    })
  );
}

async function downloadArchive(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Resource archive download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function verifyArchive(buffer: Buffer, expectedSha256: string): void {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `Resource archive digest mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  }
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
        "Registry resource id, such as template:html-ppt-playful-launch",
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
          const download = await getRegistryResourceDownload({ id: entry.id });
          if (download.sha256 !== archive.sha256) {
            throw new Error(
              `Resource archive digest metadata mismatch: expected ${archive.sha256}, got ${download.sha256}`,
            );
          }

          const buffer = await downloadArchive(download.url);
          verifyArchive(buffer, archive.sha256);

          const outputDir = path.resolve(options.dir);
          const tmpDir = await mkdtemp(path.join(tmpdir(), "zero-resource-"));
          const archivePath = path.join(tmpDir, "resource.tar.gz");
          await mkdir(outputDir, { recursive: true });
          await writeFile(archivePath, buffer);

          try {
            await tar.extract({
              file: archivePath,
              cwd: outputDir,
              gzip: true,
              filter: isSafeTarPath,
            });
          } finally {
            await rm(tmpDir, { recursive: true, force: true });
          }

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
