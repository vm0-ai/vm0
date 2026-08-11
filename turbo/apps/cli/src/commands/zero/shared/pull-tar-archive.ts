import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as tar from "tar";

interface PullTarArchiveOptions {
  readonly url: string;
  readonly expectedSha256: string;
  readonly outputDir: string;
  readonly label: string;
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

async function validateTarArchive(
  archivePath: string,
  label: string,
): Promise<void> {
  let unsafePath: string | undefined;
  await tar.list({
    file: archivePath,
    gzip: true,
    filter: (entryPath, entry) => {
      if (
        unsafePath === undefined &&
        (!isSafeTarPath(entryPath) ||
          !("type" in entry) ||
          (entry.type !== "File" && entry.type !== "Directory"))
      ) {
        unsafePath = entryPath;
      }
      return false;
    },
  });
  if (unsafePath !== undefined) {
    throw new Error(`${label} contains unsafe path: ${unsafePath}`);
  }
}

export async function pullTarArchive({
  url,
  expectedSha256,
  outputDir,
  label,
}: PullTarArchiveOptions): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} digest mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }

  const resolvedOutputDir = path.resolve(outputDir);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "zero-archive-"));
  const archivePath = path.join(tmpDir, "archive.tar.gz");
  await writeFile(archivePath, buffer);

  try {
    await validateTarArchive(archivePath, label);
    await mkdir(resolvedOutputDir, { recursive: true });
    await tar.extract({
      file: archivePath,
      cwd: resolvedOutputDir,
      gzip: true,
      filter: (entryPath, entry) => {
        return (
          isSafeTarPath(entryPath) &&
          "type" in entry &&
          (entry.type === "File" || entry.type === "Directory")
        );
      },
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  return resolvedOutputDir;
}
