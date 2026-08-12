import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";

interface StorageMap {
  readonly [slug: string]: string;
}

interface FileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface WebsiteTemplatePublication {
  readonly schemaVersion: 1;
  readonly source: {
    readonly repo: "vm0-ai/Template-artifact";
    readonly commit: string;
    readonly path: "Template-Website/archive";
  };
  readonly packages: readonly {
    readonly slug: string;
    readonly resourceId: string;
    readonly storageId?: string;
    readonly versionId?: string;
    readonly archive: {
      readonly path: string;
      readonly type: "tar.gz";
      readonly sha256: string;
      readonly byteSize: number;
    };
    readonly files: readonly FileEntry[];
  }[];
}

function readOption(name: string): string | undefined {
  const optionIndex = process.argv.indexOf(name);
  if (optionIndex === -1) {
    return undefined;
  }

  const value = process.argv[optionIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requiredOption(name: string): string {
  const value = readOption(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function computeVersionId(
  storageId: string,
  files: readonly FileEntry[],
): string {
  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();
  return sha256(`storage:${storageId}\n${entries.join("\n")}`);
}

async function listFiles(
  rootDir: string,
  relativeDir = "",
): Promise<readonly string[]> {
  const entries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => {
    return left.name.localeCompare(right.name);
  })) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported template entry: ${relativePath}`);
    }
    files.push(relativePath);
  }

  return files;
}

async function buildFileManifest(
  sourceDir: string,
  slug: string,
): Promise<readonly FileEntry[]> {
  const templateDir = path.join(sourceDir, slug);
  const relativePaths = await listFiles(templateDir);

  return await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(templateDir, relativePath);
      const [contents, metadata] = await Promise.all([
        readFile(filePath),
        stat(filePath),
      ]);
      return {
        path: path.posix.join(slug, relativePath),
        hash: sha256(contents),
        size: metadata.size,
      };
    }),
  );
}

async function readStorageMap(filePath: string | undefined) {
  if (!filePath) {
    return undefined;
  }
  return JSON.parse(
    await readFile(path.resolve(filePath), "utf8"),
  ) as StorageMap;
}

async function main(): Promise<void> {
  const sourceDir = path.resolve(requiredOption("--source-dir"));
  const outputDir = path.resolve(requiredOption("--output-dir"));
  const sourceCommit = requiredOption("--source-commit");
  const storageMap = await readStorageMap(readOption("--storage-map"));
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const slugs = entries
    .filter((entry) => {
      return entry.isDirectory();
    })
    .map((entry) => {
      return entry.name;
    })
    .sort((left, right) => {
      return left.localeCompare(right);
    });

  if (slugs.length === 0) {
    throw new Error(`No Website template directories found in ${sourceDir}`);
  }
  if (storageMap) {
    const missingStorageIds = slugs.filter((slug) => {
      return !storageMap[slug];
    });
    if (missingStorageIds.length > 0) {
      throw new Error(
        `Missing storage ids for: ${missingStorageIds.join(", ")}`,
      );
    }
  }

  await mkdir(outputDir, { recursive: true });
  const packages: WebsiteTemplatePublication["packages"][number][] = [];

  for (const slug of slugs) {
    const archiveFileName = `${slug}.tar.gz`;
    const archivePath = path.join(outputDir, archiveFileName);
    const files = await buildFileManifest(sourceDir, slug);
    await tar.create(
      {
        cwd: sourceDir,
        file: archivePath,
        gzip: true,
        noMtime: true,
        portable: true,
      },
      [slug],
    );
    const archive = await readFile(archivePath);
    const storageId = storageMap?.[slug];
    packages.push({
      slug,
      resourceId: `template:${slug}`,
      ...(storageId
        ? {
            storageId,
            versionId: computeVersionId(storageId, files),
          }
        : {}),
      archive: {
        path: archiveFileName,
        type: "tar.gz",
        sha256: sha256(archive),
        byteSize: archive.byteLength,
      },
      files,
    });
  }

  const publication: WebsiteTemplatePublication = {
    schemaVersion: 1,
    source: {
      repo: "vm0-ai/Template-artifact",
      commit: sourceCommit,
      path: "Template-Website/archive",
    },
    packages,
  };
  await writeFile(
    path.join(outputDir, "publication.json"),
    `${JSON.stringify(publication, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${outputDir}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
