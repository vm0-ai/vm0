import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { hostedDeployments } from "@vm0/db/schema/hosted-site";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import archiver from "archiver";

import { env } from "../../lib/env";
import { buildArtifactPrefix } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { db$ } from "../external/db";
import {
  downloadHostedSitesS3Buffer,
  downloadS3Buffer,
  listS3Objects,
} from "../external/s3";

interface DownloadFileResult {
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly filename: string;
}

interface HostedArtifactMetadata {
  readonly artifactKind: "hosted-site" | "presentation-html";
  readonly deploymentId: string;
}

interface ZipEntry {
  readonly path: string;
  readonly content: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostedArtifactMetadata(
  metadata: unknown,
): HostedArtifactMetadata | null {
  if (!isRecord(metadata)) {
    return null;
  }
  if (
    metadata.artifactKind !== "hosted-site" &&
    metadata.artifactKind !== "presentation-html"
  ) {
    return null;
  }
  return typeof metadata.deploymentId === "string"
    ? {
        artifactKind: metadata.artifactKind,
        deploymentId: metadata.deploymentId,
      }
    : null;
}

function hostedSiteFileKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function zipEntryPath(path: string): string {
  const segments = path.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    throw new Error(`Invalid hosted-site path: ${path}`);
  }
  return segments.join("/");
}

async function assembleZip(entries: readonly ZipEntry[]): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];

  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => {
      return chunks.push(chunk);
    });
    archive.on("end", () => {
      return resolve(Buffer.concat(chunks));
    });
    archive.on("error", reject);
  });

  for (const entry of entries) {
    archive.append(entry.content, { name: entry.path });
  }

  await archive.finalize();
  return done;
}

/**
 * Locate and download a web-uploaded file by its file ID and owning user.
 * Returns null when no matching S3 object exists.
 */
export function zeroWebDownloadFile(
  fileId: string,
  userId: string,
): Computed<Promise<DownloadFileResult | null>> {
  return computed(async (get): Promise<DownloadFileResult | null> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    if (!bucket) {
      return null;
    }

    const prefix = buildArtifactPrefix(userId, fileId);
    const objects = await get(listS3Objects(bucket, prefix));

    if (objects.length === 0) {
      const db = get(db$);
      const [artifact] = await db
        .select({
          filename: runUploadedFiles.filename,
          contentType: runUploadedFiles.contentType,
          metadata: runUploadedFiles.metadata,
        })
        .from(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.userId, userId),
            eq(runUploadedFiles.externalId, fileId),
          ),
        )
        .limit(1);

      const hostedMetadata = hostedArtifactMetadata(artifact?.metadata);
      if (!artifact || !hostedMetadata) {
        return null;
      }

      const hostedBucket = env("R2_HOSTED_SITES_BUCKET_NAME");
      if (!hostedBucket) {
        return null;
      }

      const [deployment] = await db
        .select({
          entrypoint: hostedDeployments.entrypoint,
          manifest: hostedDeployments.manifest,
          r2Prefix: hostedDeployments.r2Prefix,
        })
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.id, hostedMetadata.deploymentId),
            eq(hostedDeployments.userId, userId),
            eq(hostedDeployments.status, "ready"),
          ),
        )
        .limit(1);

      if (!deployment) {
        return null;
      }

      if (hostedMetadata.artifactKind === "hosted-site") {
        const entries: ZipEntry[] = [];
        const files = Object.values(deployment.manifest.files).sort((a, b) => {
          return a.path.localeCompare(b.path);
        });
        for (const file of files) {
          const content = await get(
            downloadHostedSitesS3Buffer(
              hostedBucket,
              hostedSiteFileKey(deployment.r2Prefix, file.path),
            ),
          );
          entries.push({ path: zipEntryPath(file.path), content });
        }
        const buffer = await assembleZip(entries);
        return {
          buffer,
          contentType: "application/zip",
          filename: `${deployment.manifest.publicSlug}.zip`,
        };
      }

      const filename =
        artifact.filename ?? `${deployment.manifest.publicSlug}.html`;
      const manifestFile = deployment.manifest.files[deployment.entrypoint];
      const contentType =
        artifact.contentType ??
        manifestFile?.contentType ??
        inferMimetype(filename);
      const buffer = await get(
        downloadHostedSitesS3Buffer(
          hostedBucket,
          hostedSiteFileKey(deployment.r2Prefix, deployment.entrypoint),
        ),
      );

      return { buffer, contentType, filename };
    }

    const s3Object = objects[0]!;
    const filename = s3Object.key.split("/").pop() ?? fileId;
    const contentType = inferMimetype(filename);
    const buffer = await get(downloadS3Buffer(bucket, s3Object.key));

    return { buffer, contentType, filename };
  });
}
