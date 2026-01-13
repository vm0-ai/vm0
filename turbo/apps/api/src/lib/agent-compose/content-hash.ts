/**
 * Content-addressable hash utilities for agent compose versioning
 * Computes SHA-256 hash of compose content for version identification
 */

import { createHash } from "crypto";
import type { AgentComposeYaml } from "../../types/agent-compose";

/**
 * Minimum length for short version ID prefix
 */
export const MIN_VERSION_PREFIX_LENGTH = 8;

/**
 * Default display length for version IDs
 */
export const DEFAULT_VERSION_DISPLAY_LENGTH = 8;

/**
 * Full SHA-256 hash length
 */
export const FULL_VERSION_LENGTH = 64;

/**
 * Recursively sort object keys for canonical JSON serialization
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compute content-addressable hash for an agent compose
 *
 * The hash is computed from the canonical JSON representation:
 * 1. Recursively sort all object keys alphabetically
 * 2. Serialize to JSON with no whitespace
 * 3. Compute SHA-256 of the JSON string
 *
 * This ensures:
 * - Same content produces same hash (deterministic)
 * - Different content produces different hash
 * - Key order doesn't affect the result (sorted)
 *
 * @param content The agent compose YAML content
 * @returns 64-character lowercase hexadecimal SHA-256 hash
 */
export function computeComposeVersionId(content: AgentComposeYaml): string {
  // Create canonical JSON representation with sorted keys
  const canonical = JSON.stringify(sortObjectKeys(content));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Format a full version ID for display (short form)
 * @param versionId Full 64-character version ID
 * @returns 8-character short version ID
 */
export function formatShortVersion(versionId: string): string {
  return versionId.slice(0, DEFAULT_VERSION_DISPLAY_LENGTH);
}

/**
 * Check if a string is a valid SHA-256 hash (64 hex characters)
 */
export function isValidVersionId(versionId: string): boolean {
  return /^[a-f0-9]{64}$/i.test(versionId);
}

/**
 * Check if a string is a valid version prefix (8+ hex characters)
 */
export function isValidVersionPrefix(prefix: string): boolean {
  return (
    /^[a-f0-9]+$/i.test(prefix) && prefix.length >= MIN_VERSION_PREFIX_LENGTH
  );
}

/**
 * Parse a compose reference string into name and version parts
 * Supported formats:
 * - "name" -> { name: "name", version: undefined } (resolves to latest)
 * - "name:latest" -> { name: "name", version: "latest" }
 * - "name:abc12345" -> { name: "name", version: "abc12345" } (version prefix/full hash)
 *
 * @param reference The compose reference string
 * @returns Parsed name and optional version
 */
export function parseComposeReference(reference: string): {
  name: string;
  version: string | undefined;
} {
  const colonIndex = reference.lastIndexOf(":");
  if (colonIndex === -1) {
    return { name: reference, version: undefined };
  }

  const name = reference.slice(0, colonIndex);
  const version = reference.slice(colonIndex + 1);

  // Empty version after colon is invalid, treat as part of name
  if (!version) {
    return { name: reference, version: undefined };
  }

  return { name, version };
}
