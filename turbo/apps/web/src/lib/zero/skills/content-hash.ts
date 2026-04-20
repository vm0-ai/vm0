/**
 * Content hash for system skills.
 * Moved from infra layer — this function is only used by sync-skills.
 */

import { createHash } from "crypto";
import type { FileEntryWithHash } from "../../infra/storage/content-hash";

/**
 * Compute content-addressable hash for a system skill.
 *
 * Uses a fixed prefix (skill URL) instead of storageId so the same
 * skill content always produces the same hash across environments.
 *
 * @param skillUrl Canonical GitHub tree URL for the skill
 * @param files Array of file entries with path and pre-computed hash
 * @returns 64-character lowercase hexadecimal SHA-256 hash
 */
export function computeSystemSkillHash(
  skillUrl: string,
  files: FileEntryWithHash[],
): string {
  if (files.length === 0) {
    return createHash("sha256")
      .update(`system-skill:${skillUrl}\n`)
      .digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();
  const combined = `system-skill:${skillUrl}\n${entries.join("\n")}`;
  return createHash("sha256").update(combined).digest("hex");
}
