import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import * as tar from "tar";

const execFileAsync = promisify(execFile);
const metadata = JSON.parse(
  await readFile(
    new URL("./website-template-release.json", import.meta.url),
    "utf8",
  ),
);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function computeVersionId(storageId, files) {
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

async function renderArchive(archivePath, slug, label) {
  const root = await mkdtemp(path.join(tmpdir(), `website-${slug}-${label}-`));
  await tar.extract({ file: archivePath, cwd: root, gzip: true });
  const templateDir = path.join(root, slug);
  const renderPath = path.join(templateDir, "render.mjs");
  const planPath = path.join(templateDir, "sample-plan.json");
  const outputPath = path.join(templateDir, "out.html");
  await Promise.all([stat(renderPath), stat(planPath)]);
  await execFileAsync(process.execPath, [renderPath, planPath, outputPath], {
    cwd: templateDir,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const html = await readFile(outputPath, "utf8");
  if (html.length < 1024 || !/<html|<!doctype/i.test(html)) {
    throw new Error(
      `${slug} ${label}: renderer did not produce a valid HTML document`,
    );
  }
  return html.length;
}

async function build() {
  const sourceDir = path.resolve(requiredOption("--source-dir"));
  const outputDir = path.resolve(requiredOption("--output-dir"));
  await mkdir(outputDir, { recursive: true });

  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const slugs = sourceEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const expectedSlugs = metadata.templates.map((entry) => entry.slug).sort();
  if (JSON.stringify(slugs) !== JSON.stringify(expectedSlugs)) {
    throw new Error(`Template set mismatch: ${JSON.stringify(slugs)}`);
  }

  const packages = [];
  for (const release of metadata.templates) {
    const files = await buildFileManifest(sourceDir, release.slug);
    const versionId = computeVersionId(release.storageId, files);
    if (versionId !== release.newVersionId) {
      throw new Error(`${release.slug}: version id mismatch (${versionId})`);
    }
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
    if (archiveSha256 !== release.newSha256) {
      throw new Error(
        `${release.slug}: archive sha256 mismatch (${archiveSha256})`,
      );
    }
    const renderedBytes = await renderArchive(
      archivePath,
      release.slug,
      "new-build",
    );
    packages.push({
      slug: release.slug,
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
      renderedBytes,
    });
    console.log(
      `VERIFIED build ${release.slug} version=${versionId} sha256=${archiveSha256} renderBytes=${renderedBytes}`,
    );
  }

  await writeFile(
    path.join(outputDir, "publication.json"),
    `${JSON.stringify({ schemaVersion: 1, source: metadata.source, packages }, null, 2)}\n`,
  );
}

async function verify() {
  const outputDir = path.resolve(requiredOption("--output-dir"));
  const publication = JSON.parse(
    await readFile(path.join(outputDir, "publication.json"), "utf8"),
  );
  if (JSON.stringify(publication.source) !== JSON.stringify(metadata.source)) {
    throw new Error("Publication source does not match the pinned release");
  }
  const packageSlugs = publication.packages
    .map((entry) => entry.slug)
    .sort((left, right) => left.localeCompare(right));
  const expectedSlugs = metadata.templates
    .map((entry) => entry.slug)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(packageSlugs) !== JSON.stringify(expectedSlugs)) {
    throw new Error(
      "Publication template set does not match the pinned release",
    );
  }

  for (const release of metadata.templates) {
    const pkg = publication.packages.find(
      (entry) => entry.slug === release.slug,
    );
    if (
      !pkg ||
      pkg.storageId !== release.storageId ||
      pkg.versionId !== release.newVersionId ||
      pkg.archive.path !== `${release.slug}.tar.gz` ||
      pkg.archive.sha256 !== release.newSha256
    ) {
      throw new Error(`${release.slug}: publication pins do not match`);
    }
    const archivePath = path.join(outputDir, pkg.archive.path);
    const archive = await readFile(archivePath);
    if (
      archive.byteLength !== pkg.archive.byteSize ||
      sha256(archive) !== release.newSha256
    ) {
      throw new Error(`${release.slug}: archive bytes do not match`);
    }

    const inspectRoot = await mkdtemp(
      path.join(tmpdir(), `website-${release.slug}-verify-`),
    );
    await tar.extract({ file: archivePath, cwd: inspectRoot, gzip: true });
    const files = await buildFileManifest(inspectRoot, release.slug);
    const versionId = computeVersionId(release.storageId, files);
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (
      versionId !== release.newVersionId ||
      pkg.fileCount !== files.length ||
      pkg.totalSize !== totalSize ||
      JSON.stringify(pkg.files) !== JSON.stringify(files)
    ) {
      throw new Error(
        `${release.slug}: extracted file manifest does not match`,
      );
    }
    const renderedBytes = await renderArchive(
      archivePath,
      release.slug,
      "verified-bundle",
    );
    console.log(
      `VERIFIED bundle ${release.slug} version=${versionId} sha256=${release.newSha256} renderBytes=${renderedBytes}`,
    );
  }
}

async function bodyToBuffer(body) {
  if (!body) throw new Error("R2 returned an empty object body");
  return Buffer.from(await body.transformToByteArray());
}

function isPreconditionFailure(error) {
  return (
    error?.name === "PreconditionFailed" ||
    error?.$metadata?.httpStatusCode === 412
  );
}

async function putImmutable(client, bucket, key, body, contentType) {
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
    if (!isPreconditionFailure(error)) throw error;
  }
}

async function getObject(client, bucket, key) {
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
  const publication = JSON.parse(
    await readFile(path.join(outputDir, "publication.json"), "utf8"),
  );
  if (
    publication.source.commit !== metadata.source.commit ||
    publication.packages.length !== metadata.templates.length
  ) {
    throw new Error("Publication metadata does not match the pinned release");
  }

  const databaseUrl = requiredEnv("DATABASE_URL");
  const bucket = requiredEnv("R2_USER_STORAGES_BUCKET_NAME");
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
    for (const release of metadata.templates) {
      const storageRows = await sql`
        SELECT id, name, s3_prefix, head_version_id
        FROM storages
        WHERE id = ${release.storageId}
      `;
      const storage = storageRows[0];
      if (!storage)
        throw new Error(`${release.slug}: production storage is missing`);
      if (storage.name !== `registry-resource@template:${release.slug}`) {
        throw new Error(`${release.slug}: unexpected production storage name`);
      }
      if (
        storage.head_version_id !== release.oldVersionId &&
        storage.head_version_id !== release.newVersionId
      ) {
        throw new Error(
          `${release.slug}: production HEAD changed unexpectedly`,
        );
      }
      const oldRows = await sql`
        SELECT id, storage_id, s3_key, archive_size, size, file_count
        FROM storage_versions
        WHERE id = ${release.oldVersionId}
      `;
      const oldVersion = oldRows[0];
      if (!oldVersion || oldVersion.storage_id !== release.storageId) {
        throw new Error(
          `${release.slug}: previous production version is missing`,
        );
      }
      state.set(release.slug, { storage, oldVersion });
    }

    for (const pkg of publication.packages) {
      const release = metadata.templates.find(
        (entry) => entry.slug === pkg.slug,
      );
      if (!release) throw new Error(`${pkg.slug}: release metadata is missing`);
      if (
        pkg.storageId !== release.storageId ||
        pkg.versionId !== release.newVersionId ||
        pkg.archive.sha256 !== release.newSha256
      ) {
        throw new Error(
          `${pkg.slug}: publication pins do not match release metadata`,
        );
      }
      const current = state.get(pkg.slug);
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

      const [newArchive, newManifestBuffer, oldArchive] = await Promise.all([
        getObject(client, bucket, `${s3Key}/archive.tar.gz`),
        getObject(client, bucket, `${s3Key}/manifest.json`),
        getObject(
          client,
          bucket,
          `${current.oldVersion.s3_key}/archive.tar.gz`,
        ),
      ]);
      if (sha256(newArchive) !== release.newSha256) {
        throw new Error(`${pkg.slug}: new R2 archive sha256 mismatch`);
      }
      if (sha256(oldArchive) !== release.oldSha256) {
        throw new Error(`${pkg.slug}: old R2 archive sha256 mismatch`);
      }
      assertManifest(
        JSON.parse(newManifestBuffer.toString("utf8")),
        manifest,
        pkg.slug,
      );

      const renderRoot = await mkdtemp(path.join(tmpdir(), `r2-${pkg.slug}-`));
      const newPath = path.join(renderRoot, "new.tar.gz");
      const oldPath = path.join(renderRoot, "old.tar.gz");
      await Promise.all([
        writeFile(newPath, newArchive),
        writeFile(oldPath, oldArchive),
      ]);
      const [newRenderBytes, oldRenderBytes] = await Promise.all([
        renderArchive(newPath, pkg.slug, "new-r2"),
        renderArchive(oldPath, pkg.slug, "old-r2"),
      ]);
      state.set(pkg.slug, {
        ...current,
        pkg,
        s3Key,
        archiveSize: newArchive.byteLength,
        newRenderBytes,
        oldRenderBytes,
      });
      console.log(
        `VERIFIED R2 ${pkg.slug} old=${release.oldVersionId}/${release.oldSha256} new=${release.newVersionId}/${release.newSha256} renderBytes=${oldRenderBytes}/${newRenderBytes}`,
      );
    }

    await sql.begin(async (tx) => {
      for (const release of metadata.templates) {
        const current = state.get(release.slug);
        const lockedRows = await tx`
          SELECT id, name, head_version_id
          FROM storages
          WHERE id = ${release.storageId}
          FOR UPDATE
        `;
        const locked = lockedRows[0];
        if (
          !locked ||
          locked.name !== `registry-resource@template:${release.slug}`
        ) {
          throw new Error(
            `${release.slug}: storage identity changed before commit`,
          );
        }
        if (
          locked.head_version_id !== release.oldVersionId &&
          locked.head_version_id !== release.newVersionId
        ) {
          throw new Error(
            `${release.slug}: storage HEAD changed before commit`,
          );
        }

        const existingRows = await tx`
          SELECT id, storage_id, s3_key, size, archive_size, file_count
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
                ${`Website template from vm0-ai/Template-artifact@${metadata.source.commit}`},
                'manual-infrastructure-upload'
              )
          `;
        }
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
    });

    for (const release of metadata.templates) {
      const rows = await sql`
        SELECT
          s.head_version_id,
          count(v.id)::int AS version_count
        FROM storages s
        JOIN storage_versions v ON v.storage_id = s.id
        WHERE
          s.id = ${release.storageId}
          AND v.id IN (${release.oldVersionId}, ${release.newVersionId})
        GROUP BY s.head_version_id
      `;
      if (
        rows.length !== 1 ||
        rows[0].head_version_id !== release.newVersionId ||
        rows[0].version_count !== 2
      ) {
        throw new Error(
          `${release.slug}: post-publication database verification failed`,
        );
      }
      const current = state.get(release.slug);
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
            Key: `${current.oldVersion.s3_key}/archive.tar.gz`,
          }),
        ),
      ]);
      console.log(
        `PUBLISHED ${release.slug} storage=${release.storageId} version=${release.newVersionId} sha256=${release.newSha256} previousVersion=${release.oldVersionId}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
    client.destroy();
  }
}

const mode = process.argv[2];
if (mode === "build") {
  await build();
} else if (mode === "verify") {
  await verify();
} else if (mode === "publish") {
  await publish();
} else {
  throw new Error("Usage: publish.mjs <build|verify|publish> [options]");
}
