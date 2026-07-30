import { createHash } from "node:crypto";

import { env } from "./env";

const ARTIFACTS_PREFIX = "artifacts";
const ARTIFACT_HASH_LENGTH = 10;
const ARTIFACT_HASH_SPACE = 36n ** BigInt(ARTIFACT_HASH_LENGTH);

/**
 * Sanitize a user-supplied filename for use in an artifact object key.
 * Replaces characters that are unsafe or problematic in URLs / object storage
 * (spaces, non-ASCII, etc.) with underscores so the key is stable and
 * predictable across upload, message storage, and retrieval.
 */
export function sanitizeArtifactFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function publicArtifactsBaseUrl(): string {
  return env("PUBLIC_ARTIFACTS_BASE_URL").replace(/\/+$/, "");
}

export function buildArtifactKey(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
}

export function buildArtifactPrefix(userId: string, id: string): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/`;
}

function artifactHash(id: string, variant?: string): string {
  const seed = variant === undefined ? id : `${id}\0${variant}`;
  const digestPrefix = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 16);
  return (BigInt(`0x${digestPrefix}`) % ARTIFACT_HASH_SPACE)
    .toString(36)
    .padStart(ARTIFACT_HASH_LENGTH, "0");
}

function artifactExtension(filename: string): string {
  const sanitized = sanitizeArtifactFilename(filename);
  const extension = sanitized.split(".").pop();
  return extension && extension !== sanitized ? extension.toLowerCase() : "bin";
}

export function buildArtifactPrefixV2(id: string, variant?: string): string {
  return `${ARTIFACTS_PREFIX}/${artifactHash(id, variant)}.`;
}

export function buildArtifactKeyV2(
  id: string,
  filename: string,
  variant?: string,
): string {
  return `${buildArtifactPrefixV2(id, variant)}${artifactExtension(filename)}`;
}

export function isArtifactKeyV2(key: string): boolean {
  return /^artifacts\/[0-9a-z]{10}\.[^/]+$/u.test(key);
}

/**
 * Build the permanent URL for an uploaded attachment.
 */
export function buildFileUrl(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${publicArtifactsBaseUrl()}/${buildArtifactKey(userId, id, filename)}`;
}

export function buildFileUrlFromKey(key: string): string {
  return `${publicArtifactsBaseUrl()}/${key.replace(/^\/+/, "")}`;
}
