import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import * as tar from "tar";

const metadata = JSON.parse(
  await readFile(
    new URL("./presentation-reverse-template-release.json", import.meta.url),
    "utf8",
  ),
);

const SYSTEM_ORG_ID = "__system__";
const VOLUME_ORG_USER_ID = "__org__";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
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
      throw new Error(`Unsupported package entry: ${relativePath}`);
    }
  }
  return files;
}

async function buildFileManifest(sourceDir, slug) {
  const packageDir = path.join(sourceDir, slug);
  const relativePaths = await listFiles(packageDir);
  return await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(packageDir, relativePath);
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

async function inspectArchive(archivePath, label) {
  const root = await mkdtemp(
    path.join(tmpdir(), `presentation-reverse-template-${label}-`),
  );
  try {
    await tar.extract({ file: archivePath, cwd: root, gzip: true });
    const rootEntries = await readdir(root, { withFileTypes: true });
    if (
      rootEntries.length !== 1 ||
      !rootEntries[0].isDirectory() ||
      rootEntries[0].name !== metadata.resource.slug
    ) {
      throw new Error(
        `${label}: archive must contain only ${metadata.resource.slug}/ at its root`,
      );
    }

    const packageDir = path.join(root, metadata.resource.slug);
    // The extractor pipeline is gone: the guide now carries only the page
    // renderer and the document-tool installer it imports.
    const required = [
      "SKILL.md",
      "scripts/render-pages.mjs",
      "scripts/libreoffice.mjs",
    ];
    for (const relativePath of required) {
      const fileStat = await stat(path.join(packageDir, relativePath));
      if (!fileStat.isFile() || fileStat.size === 0) {
        throw new Error(`${label}: ${relativePath} is missing or empty`);
      }
    }

    const skill = await readFile(path.join(packageDir, "SKILL.md"), "utf8");
    if (
      skill.length < 10_000 ||
      !skill.includes("name: presentation-reverse-template")
    ) {
      throw new Error(`${label}: SKILL.md is not the expected reverse guide`);
    }
    if (!skill.includes("node scripts/render-pages.mjs")) {
      throw new Error(
        `${label}: SKILL.md does not invoke the packaged renderer`,
      );
    }

    const renderer = await readFile(
      path.join(packageDir, "scripts/render-pages.mjs"),
      "utf8",
    );
    if (!renderer.includes('from "./libreoffice.mjs"')) {
      throw new Error(
        `${label}: the renderer does not import its packaged helper`,
      );
    }
    return { skillBytes: Buffer.byteLength(skill) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPinnedPublication(publication) {
  if (
    publication.source.repo !== metadata.source.repo ||
    publication.source.commit !== metadata.source.commit ||
    publication.source.directory !== metadata.source.directory ||
    publication.resource.id !== metadata.resource.id ||
    publication.resource.slug !== metadata.resource.slug ||
    publication.resource.storageId !== metadata.resource.storageId
  ) {
    throw new Error("Publication metadata does not match the pinned release");
  }
  if (
    metadata.resource.expectedVersionId &&
    publication.resource.versionId !== metadata.resource.expectedVersionId
  ) {
    throw new Error("Publication version id does not match the release pin");
  }
  if (
    metadata.resource.expectedSha256 &&
    publication.resource.archive.sha256 !== metadata.resource.expectedSha256
  ) {
    throw new Error(
      "Publication archive digest does not match the release pin",
    );
  }
}

async function build() {
  const sourceDir = path.resolve(requiredOption("--source-dir"));
  const outputDir = path.resolve(requiredOption("--output-dir"));
  await mkdir(outputDir, { recursive: true });

  const files = await buildFileManifest(sourceDir, metadata.resource.slug);
  const versionId = computeVersionId(metadata.resource.storageId, files);
  const archivePath = path.join(outputDir, `${metadata.resource.slug}.tar.gz`);
  await tar.create(
    {
      cwd: sourceDir,
      file: archivePath,
      gzip: true,
      noMtime: true,
      portable: true,
    },
    [metadata.resource.slug],
  );
  const archive = await readFile(archivePath);
  const publication = {
    schemaVersion: 1,
    source: metadata.source,
    resource: {
      id: metadata.resource.id,
      slug: metadata.resource.slug,
      storageId: metadata.resource.storageId,
      versionId,
      archive: {
        path: `${metadata.resource.slug}.tar.gz`,
        sha256: sha256(archive),
        byteSize: archive.byteLength,
      },
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      fileCount: files.length,
      files,
    },
  };
  assertPinnedPublication(publication);
  const inspected = await inspectArchive(archivePath, "build");
  await writeFile(
    path.join(outputDir, "publication.json"),
    `${JSON.stringify(publication, null, 2)}\n`,
  );
  console.log(
    `VERIFIED build ${publication.resource.id} version=${versionId} sha256=${publication.resource.archive.sha256} files=${publication.resource.fileCount} skillBytes=${inspected.skillBytes}`,
  );
}

async function verify() {
  const outputDir = path.resolve(requiredOption("--output-dir"));
  const publication = JSON.parse(
    await readFile(path.join(outputDir, "publication.json"), "utf8"),
  );
  assertPinnedPublication(publication);
  const archivePath = path.join(outputDir, publication.resource.archive.path);
  const archive = await readFile(archivePath);
  if (
    archive.byteLength !== publication.resource.archive.byteSize ||
    sha256(archive) !== publication.resource.archive.sha256
  ) {
    throw new Error("Archive bytes do not match the publication manifest");
  }

  const root = await mkdtemp(
    path.join(tmpdir(), "presentation-reverse-template-verify-"),
  );
  try {
    await tar.extract({ file: archivePath, cwd: root, gzip: true });
    const files = await buildFileManifest(root, publication.resource.slug);
    if (
      computeVersionId(publication.resource.storageId, files) !==
        publication.resource.versionId ||
      files.length !== publication.resource.fileCount ||
      files.reduce((sum, file) => sum + file.size, 0) !==
        publication.resource.totalSize ||
      JSON.stringify(files) !== JSON.stringify(publication.resource.files)
    ) {
      throw new Error("Extracted files do not match the publication manifest");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const inspected = await inspectArchive(archivePath, "bundle");
  console.log(
    `VERIFIED bundle ${publication.resource.id} version=${publication.resource.versionId} sha256=${publication.resource.archive.sha256} skillBytes=${inspected.skillBytes}`,
  );
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

function assertR2Manifest(actual, expected) {
  if (
    actual.version !== expected.version ||
    actual.totalSize !== expected.totalSize ||
    actual.fileCount !== expected.fileCount ||
    JSON.stringify(actual.files) !== JSON.stringify(expected.files) ||
    Number.isNaN(Date.parse(actual.createdAt))
  ) {
    throw new Error("R2 manifest does not match the publication manifest");
  }
}

function assertStorageIdentity(storage, expected) {
  if (
    storage.id !== expected.id ||
    storage.name !== expected.name ||
    storage.org_id !== SYSTEM_ORG_ID ||
    storage.user_id !== VOLUME_ORG_USER_ID ||
    storage.s3_prefix !== expected.s3Prefix ||
    (storage.head_version_id !== null &&
      storage.head_version_id !== expected.versionId)
  ) {
    throw new Error("Production storage has an unexpected identity");
  }
}

async function publish() {
  const outputDir = path.resolve(requiredOption("--output-dir"));
  const publication = JSON.parse(
    await readFile(path.join(outputDir, "publication.json"), "utf8"),
  );
  assertPinnedPublication(publication);

  const pkg = publication.resource;
  const storageName = `registry-resource@${pkg.id}`;
  const s3Prefix = `${SYSTEM_ORG_ID}/${pkg.storageId}`;
  const s3Key = `${s3Prefix}/${pkg.versionId}`;
  const expectedStorage = {
    id: pkg.storageId,
    name: storageName,
    s3Prefix,
    versionId: pkg.versionId,
  };
  const archive = await readFile(path.join(outputDir, pkg.archive.path));
  if (sha256(archive) !== pkg.archive.sha256) {
    throw new Error("Artifact changed after verification");
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

  try {
    const storageRows = await sql`
      SELECT id, user_id, org_id, name, s3_prefix, head_version_id
      FROM storages
      WHERE name = ${storageName} OR id = ${pkg.storageId}
    `;
    if (storageRows.length > 1) {
      throw new Error(
        "Multiple production storages match the release identity",
      );
    }
    if (storageRows[0]) {
      assertStorageIdentity(storageRows[0], expectedStorage);
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

    const [r2Archive, r2ManifestBuffer] = await Promise.all([
      getObject(client, bucket, `${s3Key}/archive.tar.gz`),
      getObject(client, bucket, `${s3Key}/manifest.json`),
    ]);
    if (sha256(r2Archive) !== pkg.archive.sha256) {
      throw new Error("R2 archive digest does not match the release pin");
    }
    assertR2Manifest(JSON.parse(r2ManifestBuffer.toString("utf8")), manifest);
    const inspectRoot = await mkdtemp(
      path.join(tmpdir(), "presentation-reverse-template-r2-"),
    );
    const r2ArchivePath = path.join(inspectRoot, "archive.tar.gz");
    try {
      await writeFile(r2ArchivePath, r2Archive);
      await inspectArchive(r2ArchivePath, "r2");
    } finally {
      await rm(inspectRoot, { recursive: true, force: true });
    }

    await sql.begin(async (tx) => {
      const lockedRows = await tx`
        SELECT id, user_id, org_id, name, s3_prefix, head_version_id
        FROM storages
        WHERE name = ${storageName} OR id = ${pkg.storageId}
        FOR UPDATE
      `;
      if (lockedRows.length > 1) {
        throw new Error("Storage identity became ambiguous before commit");
      }
      if (lockedRows[0]) {
        assertStorageIdentity(lockedRows[0], expectedStorage);
      } else {
        await tx`
          INSERT INTO storages
            (id, user_id, name, org_id, s3_prefix, size, file_count)
          VALUES
            (
              ${pkg.storageId},
              ${VOLUME_ORG_USER_ID},
              ${storageName},
              ${SYSTEM_ORG_ID},
              ${s3Prefix},
              0,
              0
            )
        `;
      }

      const versionRows = await tx`
        SELECT id, storage_id, s3_key, size, archive_size, file_count
        FROM storage_versions
        WHERE id = ${pkg.versionId}
        FOR UPDATE
      `;
      const existing = versionRows[0];
      if (existing) {
        if (
          existing.storage_id !== pkg.storageId ||
          existing.s3_key !== s3Key ||
          Number(existing.size) !== pkg.totalSize ||
          Number(existing.archive_size) !== r2Archive.byteLength ||
          existing.file_count !== pkg.fileCount
        ) {
          throw new Error("Existing storage version has a different identity");
        }
      } else {
        await tx`
          INSERT INTO storage_versions
            (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
          VALUES
            (
              ${pkg.versionId},
              ${pkg.storageId},
              ${s3Key},
              ${pkg.totalSize},
              ${r2Archive.byteLength},
              ${pkg.fileCount},
              ${`Presentation reverse-template guide from ${metadata.source.repo}@${metadata.source.commit}`},
              'manual-infrastructure-upload'
            )
        `;
      }

      await tx`
        UPDATE storages
        SET
          head_version_id = ${pkg.versionId},
          size = ${pkg.totalSize},
          file_count = ${pkg.fileCount},
          updated_at = now()
        WHERE id = ${pkg.storageId}
      `;
    });

    const rows = await sql`
      SELECT
        s.id,
        s.user_id,
        s.org_id,
        s.name,
        s.s3_prefix,
        s.head_version_id,
        v.id AS version_id,
        v.s3_key,
        v.size,
        v.archive_size,
        v.file_count
      FROM storages s
      JOIN storage_versions v ON v.storage_id = s.id
      WHERE s.id = ${pkg.storageId} AND v.id = ${pkg.versionId}
    `;
    if (rows.length !== 1) {
      throw new Error("Post-publication database verification failed");
    }
    assertStorageIdentity(rows[0], expectedStorage);
    if (
      rows[0].version_id !== pkg.versionId ||
      rows[0].s3_key !== s3Key ||
      Number(rows[0].size) !== pkg.totalSize ||
      Number(rows[0].archive_size) !== r2Archive.byteLength ||
      rows[0].file_count !== pkg.fileCount
    ) {
      throw new Error("Published version does not match the release metadata");
    }
    await Promise.all([
      client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: `${s3Key}/archive.tar.gz`,
        }),
      ),
      client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: `${s3Key}/manifest.json`,
        }),
      ),
    ]);
    console.log(
      `PUBLISHED ${pkg.id} storage=${pkg.storageId} version=${pkg.versionId} sha256=${pkg.archive.sha256}`,
    );
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
