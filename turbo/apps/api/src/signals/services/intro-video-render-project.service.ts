import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { command } from "ccstate";
import { MAX_INTRO_VIDEO_PROJECT_BYTES } from "@okouai/api-contracts/contracts/intro-video-render";
import { safeSync } from "../utils";
import { env } from "../../lib/env";
import {
  downloadS3BufferWithMaxBytes,
  generatePresignedGetUrl,
  putImmutableS3Object,
} from "../external/s3";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

export class IntroVideoProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "IntroVideoProjectError";
  }
}

function unsafeArchivePath(path: string): boolean {
  return (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    path.split("/").some((part) => {
      return !part || part === ".." || part === ".";
    })
  );
}

function validateProject(bytes: Buffer, composition: string): void {
  if (bytes.byteLength > MAX_INTRO_VIDEO_PROJECT_BYTES) {
    throw new IntroVideoProjectError(
      "PROJECT_TOO_LARGE",
      "Project ZIP must be at most 200 MiB",
      413,
    );
  }
  const validated = safeSync(() => {
    const entries = new AdmZip(bytes).getEntries();
    if (!entries.length || entries.length > 10_000) {
      throw new Error("Invalid archive entry count");
    }
    const names = new Set<string>();
    let expandedSize = 0;
    for (const entry of entries) {
      const path = entry.entryName.replace(/\/$/, "");
      if (
        unsafeArchivePath(path) ||
        names.has(path) ||
        (entry.header.flags & 1) !== 0 ||
        ((entry.header.attr >>> 16) & 0o17_0000) === 0o12_0000
      ) {
        throw new Error("Unsafe archive entry");
      }
      names.add(path);
      expandedSize += entry.header.size;
      if (expandedSize > 1024 * 1024 * 1024) {
        throw new Error("Expanded project exceeds 1 GiB");
      }
    }
    const entry = entries.find((item) => {
      return item.entryName === composition && !item.isDirectory;
    });
    if (!entry || entry.header.size > 1024 * 1024) {
      throw new Error("Missing or oversized HTML entry");
    }
    const compressed = entry.getCompressedData();
    const decoded =
      entry.header.method === 0
        ? compressed
        : entry.header.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: 1024 * 1024 })
          : null;
    if (
      !decoded ||
      decoded.length !== entry.header.size ||
      !decoded.toString("utf8").trim()
    ) {
      throw new Error("Empty HTML entry");
    }
  });
  if ("error" in validated) {
    throw new IntroVideoProjectError(
      "INVALID_RENDER_PROJECT",
      validated.error instanceof Error
        ? validated.error.message
        : "Invalid project ZIP",
    );
  }
}

export const prepareIntroVideoRenderProject$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly projectFileId: string;
      readonly generationId: string;
      readonly composition: string;
    },
    signal: AbortSignal,
  ) => {
    const object = await get(
      uploadedArtifactObject({
        id: args.projectFileId,
        userId: args.userId,
        orgId: args.orgId,
      }),
    );
    signal.throwIfAborted();
    if (!object) {
      throw new IntroVideoProjectError(
        "NOT_FOUND",
        "Project file not found",
        404,
      );
    }
    if (object.size > MAX_INTRO_VIDEO_PROJECT_BYTES) {
      throw new IntroVideoProjectError(
        "PROJECT_TOO_LARGE",
        "Project ZIP must be at most 200 MiB",
        413,
      );
    }
    if (
      !["application/zip", "application/x-zip-compressed"].includes(
        object.contentType,
      )
    ) {
      throw new IntroVideoProjectError(
        "INVALID_RENDER_PROJECT",
        "Upload a project ZIP to Okou first",
      );
    }
    const bytes = await get(
      downloadS3BufferWithMaxBytes(
        object.bucket,
        object.key,
        MAX_INTRO_VIDEO_PROJECT_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    validateProject(bytes, args.composition);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
    if (!bucket || bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
      throw new Error("Private render input storage is not configured");
    }
    const key = `intro-video-render-inputs/${args.generationId}/${digest}.zip`;
    await get(
      putImmutableS3Object(bucket, key, bytes, "application/zip", signal),
    );
    signal.throwIfAborted();
    const url = await get(
      generatePresignedGetUrl(bucket, key, 26 * 60 * 60, undefined, true),
    );
    signal.throwIfAborted();
    return { digest, key, url };
  },
);
