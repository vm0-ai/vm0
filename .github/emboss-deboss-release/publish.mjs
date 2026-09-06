import { createHash } from "node:crypto";
import {
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
    new URL("./emboss-deboss-release.json", import.meta.url),
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

function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
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
  for (const entry of entries.sort(compareNames)) {
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

async function buildFileManifest(rootDir) {
  const relativePaths = await listFiles(rootDir);
  return await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(rootDir, relativePath);
      const [contents, fileStat] = await Promise.all([
        readFile(filePath),
        stat(filePath),
      ]);
      return {
        path: relativePath,
        hash: sha256(contents),
        size: fileStat.size,
      };
    }),
  );
}

async function inspectArchive(archivePath, label) {
  const root = await mkdtemp(path.join(tmpdir(), `emboss-deboss-${label}-`));
  try {
    const seen = new Set();
    await tar.list({
      file: archivePath,
      gzip: true,
      onReadEntry(entry) {
        const entryPath = entry.path.replace(/\/$/, "");
        if (
          !["File", "Directory"].includes(entry.type) ||
          path.posix.isAbsolute(entryPath) ||
          entryPath.split("/").includes("..") ||
          entryPath.includes("\\") ||
          seen.has(entryPath) ||
          !(
            entryPath === metadata.resource.archiveRoot ||
            entryPath === metadata.resource.packagePath ||
            entryPath.startsWith(`${metadata.resource.packagePath}/`)
          )
        ) {
          throw new Error(`${label}: unsupported archive entry ${entry.path}`);
        }
        seen.add(entryPath);
      },
    });
    await tar.extract({
      file: archivePath,
      cwd: root,
      gzip: true,
      strict: true,
    });
    const rootEntries = await readdir(root, { withFileTypes: true });
    if (
      rootEntries.length !== 1 ||
      !rootEntries[0].isDirectory() ||
      rootEntries[0].name !== metadata.resource.archiveRoot
    ) {
      throw new Error(
        `${label}: archive must contain only ${metadata.resource.archiveRoot}/ at its root`,
      );
    }

    const archiveRoot = path.join(root, metadata.resource.archiveRoot);
    const archiveRootEntries = await readdir(archiveRoot, {
      withFileTypes: true,
    });
    const packageName = path.posix.basename(metadata.resource.packagePath);
    if (
      archiveRootEntries.length !== 1 ||
      !archiveRootEntries[0].isDirectory() ||
      archiveRootEntries[0].name !== packageName
    ) {
      throw new Error(
        `${label}: ${metadata.resource.archiveRoot}/ must contain only ${packageName}/`,
      );
    }

    const packageDir = path.join(root, metadata.resource.packagePath);
    const required = [
      "SKILL.md",
      "ref-beyond-ivory.jpg",
      "ref-moon-boat-no-text.jpg",
      "ref-moon-mooring-indigo.jpg",
      "ref-weightless-indigo.jpg",
      "ref-wind-space-blush.jpg",
    ];
    for (const relativePath of required) {
      const fileStat = await stat(path.join(packageDir, relativePath));
      if (!fileStat.isFile() || fileStat.size === 0) {
        throw new Error(`${label}: ${relativePath} is missing or empty`);
      }
    }
    const packageFiles = await listFiles(packageDir);
    if (JSON.stringify(packageFiles) !== JSON.stringify(required.toSorted())) {
      throw new Error(
        `${label}: package must contain exactly the approved six files`,
      );
    }
    const skill = await readFile(path.join(packageDir, "SKILL.md"), "utf8");
    if (!skill.includes("name: emboss-deboss")) {
      throw new Error(`${label}: SKILL.md is not the emboss-deboss package`);
    }

    return {
      files: await buildFileManifest(root),
      verification: "approved six-file paper-relief package",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPinnedPublication(publication) {
  if (
    publication.schemaVersion !== 1 ||
    JSON.stringify(publication.source) !== JSON.stringify(metadata.source) ||
    publication.resource.id !== metadata.resource.id ||
    publication.resource.archiveRoot !== metadata.resource.archiveRoot ||
    publication.resource.packagePath !== metadata.resource.packagePath ||
    publication.resource.storageId !== metadata.resource.storageId ||
    publication.resource.archive.path !== "emboss-deboss.tar.gz"
  ) {
    throw new Error("Publication metadata does not match the pinned release");
  }
  if (publication.resource.versionId !== metadata.resource.expectedVersionId) {
    throw new Error("Publication version id does not match the release pin");
  }
  if (
    publication.resource.archive.sha256 !== metadata.resource.expectedSha256
  ) {
    throw new Error(
      "Publication archive digest does not match the release pin",
    );
  }
}

async function verifyBundle(outputDir, label) {
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
    throw new Error(
      `${label}: archive bytes do not match the publication manifest`,
    );
  }

  const inspected = await inspectArchive(archivePath, label);
  const files = inspected.files;
  if (
    computeVersionId(publication.resource.storageId, files) !==
      publication.resource.versionId ||
    files.length !== publication.resource.fileCount ||
    files.reduce((sum, file) => sum + file.size, 0) !==
      publication.resource.totalSize ||
    JSON.stringify(files) !== JSON.stringify(publication.resource.files)
  ) {
    throw new Error(
      `${label}: extracted files do not match the publication manifest`,
    );
  }

  console.log(
    `VERIFIED ${label} ${publication.resource.id} version=${publication.resource.versionId} sha256=${publication.resource.archive.sha256} files=${publication.resource.fileCount}; ${inspected.verification}`,
  );
  return publication;
}

async function verify() {
  const outputDir = path.resolve(requiredOption("--output-dir"));
  await verifyBundle(outputDir, "bundle");
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
  const publication = await verifyBundle(outputDir, "publish-input");
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

    const inspectRoot = await mkdtemp(path.join(tmpdir(), "emboss-deboss-r2-"));
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
              ${`Emboss & Deboss image style from ${metadata.source.repo}@${metadata.source.commit}`},
              'github-actions-emboss-deboss-publisher'
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
      rows[0].head_version_id !== pkg.versionId ||
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
if (mode === "verify") {
  await verify();
} else if (mode === "publish") {
  await publish();
} else {
  throw new Error("Usage: publish.mjs <verify|publish> --output-dir <path>");
}
