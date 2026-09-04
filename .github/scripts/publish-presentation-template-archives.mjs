/* eslint-disable complexity, max-lines-per-function, no-console */
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_URL = new URL(
  "./presentation-template-release.json",
  import.meta.url,
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PUBLISHER = "github-actions-presentation-template-publisher";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameSet(actual, expected, label) {
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
    throw new Error(`${label} mismatch: ${JSON.stringify(sorted(actual))}`);
  }
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

async function loadConfig() {
  const config = await readJson(CONFIG_URL);
  if (
    config.schemaVersion !== 1 ||
    config.source?.repository !== "vm0-ai/Template-artifact" ||
    config.source?.ref !== "main" ||
    config.source?.directory !== "Template-Presentation" ||
    !Array.isArray(config.templates) ||
    config.templates.length === 0
  ) {
    throw new Error("Presentation release configuration is invalid");
  }
  assertUnique(
    config.templates.map((entry) => entry.slug),
    "Template slugs",
  );
  assertUnique(
    config.templates.map((entry) => entry.resourceId),
    "Template resource ids",
  );
  assertUnique(
    config.templates.map((entry) => entry.storageId),
    "Template storage ids",
  );
  for (const entry of config.templates) {
    if (
      typeof entry.slug !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug) ||
      typeof entry.resourceId !== "string" ||
      !/^template:html-ppt-[a-z0-9]+(?:-[a-z0-9]+)*-runbook$/.test(
        entry.resourceId,
      ) ||
      typeof entry.defaultColorSystem !== "string" ||
      !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(entry.defaultColorSystem) ||
      typeof entry.storageId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(entry.storageId)
    ) {
      throw new Error(`${entry.slug ?? "unknown"}: invalid release metadata`);
    }
  }
  return config;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeVersionId(storageId, files) {
  const entries = files.map((file) => `${file.path}:${file.hash}`).sort();
  return sha256(`storage:${storageId}\n${entries.join("\n")}`);
}

async function listFiles(rootDir, relativeDir = "") {
  const entries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) => {
    return left.name.localeCompare(right.name);
  })) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported template entry: ${relativePath}`);
    }
  }
  return files;
}

async function buildFileManifest(sourceDir, slug) {
  const templateDir = path.join(sourceDir, slug);
  const relativePaths = await listFiles(templateDir);
  return await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(templateDir, relativePath);
      const [contents, fileStat] = await Promise.all([
        readFile(filePath),
        stat(filePath),
      ]);
      return {
        path: path.posix.join(slug, relativePath),
        hash: sha256(contents),
        size: fileStat.size,
      };
    }),
  );
}

async function loadTar() {
  return await import("tar");
}

/**
 * Assert the archive is the kind of package the prompt describes.
 *
 * These packages carry no renderer, so there is nothing to execute as a smoke
 * test. What can go wrong instead is shape: a run is told to read `SKILL.md`
 * and to inline a package-local colour file, and either being absent breaks the
 * run after it has already paid for the download. Self-containment is checked
 * too, because these templates previously read `../color-systems/`, which
 * resolves outside the extracted package and silently yields no stylesheet.
 */
async function inspectArchive(archivePath, release, label) {
  const tar = await loadTar();
  const { slug } = release;
  const root = await mkdtemp(
    path.join(tmpdir(), `presentation-${slug}-${label}-`),
  );
  await tar.extract({ file: archivePath, cwd: root, gzip: true });
  const templateDir = path.join(root, slug);

  const required = [
    "SKILL.md",
    "design-system.md",
    "layouts/_shell.html",
    `color-systems/${release.defaultColorSystem}.css`,
  ];
  for (const relativePath of required) {
    const fileStat = await stat(path.join(templateDir, relativePath));
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new Error(`${slug} ${label}: ${relativePath} is missing or empty`);
    }
  }

  const skill = await readFile(path.join(templateDir, "SKILL.md"), "utf8");
  if (skill.length < 1024) {
    throw new Error(`${slug} ${label}: SKILL.md is too short to be guidance`);
  }

  const relativePaths = await listFiles(templateDir);
  const present = new Set(relativePaths);
  const dangling = [];
  for (const relativePath of relativePaths) {
    if (!/\.(md|html|css|js|sh)$/.test(relativePath)) {
      continue;
    }
    const contents = await readFile(
      path.join(templateDir, relativePath),
      "utf8",
    );
    for (const match of contents.matchAll(
      /(?<![\w/.-])((?:\.\.\/)*color-systems\/[\w.-]+\.css)/g,
    )) {
      // Resolve against the referring file, then require the result to land on
      // a file the archive actually carries. A reference that resolves above
      // the package root leaves the extracted directory entirely, which is how
      // the previous layout silently produced an unstyled deck.
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativePath), match[1]),
      );
      if (target.startsWith("..") || !present.has(target)) {
        dangling.push(`${relativePath} -> ${match[1]}`);
      }
    }
  }
  if (dangling.length > 0) {
    throw new Error(
      `${slug} ${label}: colour-system references do not resolve inside the package (${dangling.join(", ")})`,
    );
  }

  const colorSystems = relativePaths.filter((relativePath) => {
    return relativePath.startsWith("color-systems/");
  });
  return { skillBytes: skill.length, colorSystemCount: colorSystems.length };
}

async function build() {
  const config = await loadConfig();
  const sourceDir = path.resolve(requiredOption("--source-dir"));
  const outputDir = path.resolve(requiredOption("--output-dir"));
  const sourceCommit = requiredOption("--source-commit");
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("--source-commit must be a full lowercase Git commit SHA");
  }
  await mkdir(outputDir, { recursive: true });

  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const slugs = sourceEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  assertSameSet(
    slugs,
    config.templates.map((entry) => entry.slug),
    "Template source set",
  );

  const tar = await loadTar();
  const packages = [];
  for (const release of config.templates) {
    const files = await buildFileManifest(sourceDir, release.slug);
    const versionId = computeVersionId(release.storageId, files);
    const archivePath = path.join(outputDir, `${release.slug}.tar.gz`);
    await tar.create(
      {
        cwd: sourceDir,
        file: archivePath,
        gzip: true,
        noMtime: true,
        portable: true,
      },
      [release.slug],
    );
    const archive = await readFile(archivePath);
    const archiveSha256 = sha256(archive);
    const inspected = await inspectArchive(archivePath, release, "new-build");
    packages.push({
      slug: release.slug,
      resourceId: release.resourceId,
      storageId: release.storageId,
      versionId,
      archive: {
        path: `${release.slug}.tar.gz`,
        sha256: archiveSha256,
        byteSize: archive.byteLength,
      },
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      fileCount: files.length,
      files,
      ...inspected,
    });
    console.log(
      `VERIFIED build ${release.slug} version=${versionId} sha256=${archiveSha256} skillBytes=${inspected.skillBytes} colorSystems=${inspected.colorSystemCount}`,
    );
  }

  const source = { ...config.source, commit: sourceCommit };
  await writeFile(
    path.join(outputDir, "publication.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source,
        packages,
      },
      null,
      2,
    )}\n`,
  );
}

async function verifyBundle(outputDir) {
  const config = await loadConfig();
  const publication = await readJson(path.join(outputDir, "publication.json"));
  if (
    publication.schemaVersion !== 1 ||
    publication.source?.repository !== config.source.repository ||
    publication.source?.ref !== config.source.ref ||
    publication.source?.directory !== config.source.directory ||
    !COMMIT_PATTERN.test(publication.source?.commit) ||
    !Array.isArray(publication.packages)
  ) {
    throw new Error(
      "Publication metadata does not match the current release inputs",
    );
  }
  assertSameSet(
    publication.packages.map((entry) => entry.slug),
    config.templates.map((entry) => entry.slug),
    "Publication template set",
  );

  const tar = await loadTar();
  for (const release of config.templates) {
    const pkg = publication.packages.find(
      (entry) => entry.slug === release.slug,
    );
    if (
      !pkg ||
      pkg.resourceId !== release.resourceId ||
      pkg.storageId !== release.storageId ||
      pkg.archive.path !== `${release.slug}.tar.gz`
    ) {
      throw new Error(`${release.slug}: publication metadata does not match`);
    }
    assertSha256(pkg.versionId, `${release.slug} publication version id`);
    assertSha256(pkg.archive.sha256, `${release.slug} publication sha256`);
    const archivePath = path.join(outputDir, pkg.archive.path);
    const archive = await readFile(archivePath);
    if (
      archive.byteLength !== pkg.archive.byteSize ||
      sha256(archive) !== pkg.archive.sha256
    ) {
      throw new Error(`${release.slug}: archive bytes do not match`);
    }

    const inspectRoot = await mkdtemp(
      path.join(tmpdir(), `presentation-${release.slug}-verify-`),
    );
    await tar.extract({ file: archivePath, cwd: inspectRoot, gzip: true });
    const files = await buildFileManifest(inspectRoot, release.slug);
    const versionId = computeVersionId(release.storageId, files);
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (
      versionId !== pkg.versionId ||
      pkg.fileCount !== files.length ||
      pkg.totalSize !== totalSize ||
      JSON.stringify(pkg.files) !== JSON.stringify(files)
    ) {
      throw new Error(
        `${release.slug}: extracted file manifest does not match`,
      );
    }
    const inspected = await inspectArchive(
      archivePath,
      release,
      "verified-bundle",
    );
    console.log(
      `VERIFIED bundle ${release.slug} version=${versionId} sha256=${pkg.archive.sha256} skillBytes=${inspected.skillBytes} colorSystems=${inspected.colorSystemCount}`,
    );
  }

  return { config, publication };
}

async function verify() {
  const outputDir = path.resolve(requiredOption("--output-dir"));
  await verifyBundle(outputDir);
}

async function bodyToBuffer(body) {
  if (!body) {
    throw new Error("R2 returned an empty object body");
  }
  return Buffer.from(await body.transformToByteArray());
}

function isPreconditionFailure(error) {
  return (
    error?.name === "PreconditionFailed" ||
    error?.$metadata?.httpStatusCode === 412
  );
}

async function putImmutable(client, bucket, key, body, contentType) {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!isPreconditionFailure(error)) {
      throw error;
    }
  }
}

async function getObject(client, bucket, key) {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return await bodyToBuffer(response.Body);
}

function assertManifest(actual, expected, slug) {
  if (
    actual.version !== expected.version ||
    actual.totalSize !== expected.totalSize ||
    actual.fileCount !== expected.fileCount ||
    JSON.stringify(actual.files) !== JSON.stringify(expected.files) ||
    Number.isNaN(Date.parse(actual.createdAt))
  ) {
    throw new Error(
      `${slug}: R2 manifest does not match the publication manifest`,
    );
  }
}

async function publish() {
  const outputDir = path.resolve(requiredOption("--output-dir"));
  const { config, publication } = await verifyBundle(outputDir);
  const releases = config.templates.map((release) => {
    const pkg = publication.packages.find(
      (entry) => entry.slug === release.slug,
    );
    if (!pkg) {
      throw new Error(`${release.slug}: publication package is missing`);
    }
    return {
      ...release,
      newVersionId: pkg.versionId,
      newSha256: pkg.archive.sha256,
    };
  });

  const databaseUrl = requiredEnv("DATABASE_URL");
  const bucket = requiredEnv("R2_USER_STORAGES_BUCKET_NAME");
  const { HeadObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const { default: postgres } = await import("postgres");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const sql = postgres(databaseUrl, { max: 1 });
  const state = new Map();

  try {
    for (const release of releases) {
      const storageRows = await sql`
        SELECT id, name, s3_prefix, head_version_id
        FROM storages
        WHERE id = ${release.storageId}
      `;
      const storage = storageRows[0];
      if (!storage) {
        throw new Error(`${release.slug}: production storage is missing`);
      }
      if (storage.name !== `registry-resource@${release.resourceId}`) {
        throw new Error(`${release.slug}: unexpected production storage name`);
      }
      if (!storage.head_version_id) {
        throw new Error(
          `${release.slug}: production storage does not have a HEAD`,
        );
      }

      const predecessorRows = await sql`
        SELECT id
        FROM storage_versions
        WHERE
          id = ${storage.head_version_id}
          AND storage_id = ${release.storageId}
      `;
      if (!predecessorRows[0]) {
        throw new Error(
          `${release.slug}: production HEAD does not belong to its storage`,
        );
      }

      state.set(release.slug, {
        storage,
        previousVersionId: storage.head_version_id,
      });
    }

    for (const pkg of publication.packages) {
      const release = releases.find((entry) => entry.slug === pkg.slug);
      if (!release) {
        throw new Error(`${pkg.slug}: release metadata is missing`);
      }
      if (
        pkg.storageId !== release.storageId ||
        pkg.versionId !== release.newVersionId ||
        pkg.archive.sha256 !== release.newSha256
      ) {
        throw new Error(
          `${pkg.slug}: publication does not match release metadata`,
        );
      }

      const current = state.get(pkg.slug);
      if (!current) {
        throw new Error(`${pkg.slug}: production storage state is missing`);
      }
      const s3Key = `${current.storage.s3_prefix}/${pkg.versionId}`;
      const archive = await readFile(path.join(outputDir, pkg.archive.path));
      if (sha256(archive) !== release.newSha256) {
        throw new Error(`${pkg.slug}: artifact changed after verification`);
      }
      const manifest = {
        version: pkg.versionId,
        createdAt: new Date().toISOString(),
        totalSize: pkg.totalSize,
        fileCount: pkg.fileCount,
        files: pkg.files,
      };

      await putImmutable(
        client,
        bucket,
        `${s3Key}/archive.tar.gz`,
        archive,
        "application/gzip",
      );
      await putImmutable(
        client,
        bucket,
        `${s3Key}/manifest.json`,
        `${JSON.stringify(manifest)}\n`,
        "application/json",
      );

      const [uploadedArchive, uploadedManifest] = await Promise.all([
        getObject(client, bucket, `${s3Key}/archive.tar.gz`),
        getObject(client, bucket, `${s3Key}/manifest.json`),
      ]);
      if (sha256(uploadedArchive) !== release.newSha256) {
        throw new Error(`${pkg.slug}: uploaded R2 archive sha256 mismatch`);
      }
      assertManifest(
        JSON.parse(uploadedManifest.toString("utf8")),
        manifest,
        pkg.slug,
      );

      const inspectRoot = await mkdtemp(path.join(tmpdir(), `r2-${pkg.slug}-`));
      const uploadedPath = path.join(inspectRoot, "archive.tar.gz");
      await writeFile(uploadedPath, uploadedArchive);
      const inspected = await inspectArchive(
        uploadedPath,
        release,
        "uploaded-r2",
      );

      state.set(pkg.slug, {
        ...current,
        pkg,
        s3Key,
        archiveSize: uploadedArchive.byteLength,
      });
      console.log(
        `VERIFIED R2 ${pkg.slug} version=${release.newVersionId} sha256=${release.newSha256} skillBytes=${inspected.skillBytes}`,
      );
    }

    await sql.begin(async (tx) => {
      for (const release of releases) {
        const current = state.get(release.slug);
        if (!current?.pkg) {
          throw new Error(`${release.slug}: verified upload state is missing`);
        }

        const lockedRows = await tx`
          SELECT id, name, head_version_id, size, file_count
          FROM storages
          WHERE id = ${release.storageId}
          FOR UPDATE
        `;
        const locked = lockedRows[0];
        if (
          !locked ||
          locked.name !== `registry-resource@${release.resourceId}`
        ) {
          throw new Error(
            `${release.slug}: storage identity changed before commit`,
          );
        }
        if (
          locked.head_version_id !== current.previousVersionId &&
          locked.head_version_id !== release.newVersionId
        ) {
          throw new Error(
            `${release.slug}: storage HEAD changed before commit`,
          );
        }

        const existingRows = await tx`
          SELECT
            id,
            storage_id,
            s3_key,
            size,
            archive_size,
            file_count
          FROM storage_versions
          WHERE id = ${release.newVersionId}
        `;
        const existing = existingRows[0];
        if (existing) {
          if (
            existing.storage_id !== release.storageId ||
            existing.s3_key !== current.s3Key ||
            Number(existing.size) !== current.pkg.totalSize ||
            Number(existing.archive_size) !== current.archiveSize ||
            existing.file_count !== current.pkg.fileCount
          ) {
            throw new Error(
              `${release.slug}: existing version row has different identity`,
            );
          }
        } else {
          await tx`
            INSERT INTO storage_versions
              (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
            VALUES
              (
                ${release.newVersionId},
                ${release.storageId},
                ${current.s3Key},
                ${current.pkg.totalSize},
                ${current.archiveSize},
                ${current.pkg.fileCount},
                ${`Template-artifact@${publication.source.commit}`},
                ${PUBLISHER}
              )
          `;
        }

        if (
          locked.head_version_id !== release.newVersionId ||
          Number(locked.size) !== current.pkg.totalSize ||
          locked.file_count !== current.pkg.fileCount
        ) {
          await tx`
            UPDATE storages
            SET
              head_version_id = ${release.newVersionId},
              size = ${current.pkg.totalSize},
              file_count = ${current.pkg.fileCount},
              updated_at = now()
            WHERE id = ${release.storageId}
          `;
        }
      }
    });

    for (const release of releases) {
      const current = state.get(release.slug);
      const rows = await sql`
        SELECT
          s.head_version_id,
          count(v.id)::int AS version_count
        FROM storages s
        JOIN storage_versions v ON v.storage_id = s.id
        WHERE
          s.id = ${release.storageId}
          AND v.id IN (${current.previousVersionId}, ${release.newVersionId})
        GROUP BY s.head_version_id
      `;
      if (
        rows.length !== 1 ||
        rows[0].head_version_id !== release.newVersionId ||
        rows[0].version_count !==
          (current.previousVersionId === release.newVersionId ? 1 : 2)
      ) {
        throw new Error(
          `${release.slug}: post-publication database verification failed`,
        );
      }

      await Promise.all([
        client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: `${current.s3Key}/archive.tar.gz`,
          }),
        ),
        client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: `${current.s3Key}/manifest.json`,
          }),
        ),
      ]);
      console.log(
        `PUBLISHED ${release.slug} storage=${release.storageId} version=${release.newVersionId} sha256=${release.newSha256} previousVersion=${current.previousVersionId}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
    client.destroy();
  }
}
async function run() {
  const mode = process.argv[2];
  if (mode === "build") {
    await build();
  } else if (mode === "verify") {
    await verify();
  } else if (mode === "publish") {
    await publish();
  } else {
    throw new Error(
      "Usage: publish-presentation-template-archives.mjs <build|verify|publish> [options]",
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await run();
}
