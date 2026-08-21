import { createHash } from "node:crypto";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

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

export function publicArtifactsBaseUrlForBrand(
  publicBrand: PublicBrand,
): string {
  // API/config rollout compatibility: environments that predate the branded
  // CDN config still have only PUBLIC_ARTIFACTS_BASE_URL. Remove after every
  // supported API environment provides OKOU_PUBLIC_ARTIFACTS_BASE_URL and the
  // prior API is outside the observed ~102-minute rollout/rollback window.
  // Tracked by #28449.
  const configuredUrl =
    publicBrand === "okou"
      ? (env("OKOU_PUBLIC_ARTIFACTS_BASE_URL") ??
        env("PUBLIC_ARTIFACTS_BASE_URL"))
      : env("PUBLIC_ARTIFACTS_BASE_URL");
  return configuredUrl.replace(/\/+$/, "");
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

export function buildFileUrlFromKey(
  key: string,
  publicBrand: PublicBrand,
): string {
  return `${publicArtifactsBaseUrlForBrand(publicBrand)}/${key.replace(/^\/+/, "")}`;
}
