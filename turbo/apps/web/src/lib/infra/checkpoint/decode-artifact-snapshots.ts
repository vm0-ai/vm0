import { badRequest } from "@vm0/api-services/errors";
import type { ContextArtifact } from "../run/types";

/**
 * Decoders for the `checkpoints.artifact_snapshots` JSONB column.
 *
 * The column always stores the canonical `Array<{name, version, mountPath}>`
 * form. Legacy `Record<name, version>` payloads were migrated in #10912 and
 * writer support was removed in #10911 — readers therefore reject non-array
 * payloads with a descriptive error rather than silently tolerating them.
 */

/**
 * Decode the JSONB column into the unified `ContextArtifact[]` form consumed
 * by `resolve-checkpoint.ts` and any other code path that needs mountPath
 * stamped on every entry.
 */
export function decodeToContextArtifacts(raw: unknown): ContextArtifact[] {
  if (raw === null || raw === undefined) return [];

  if (!Array.isArray(raw)) {
    throw badRequest("Invalid checkpoint: artifactSnapshots must be an array");
  }

  return raw.map((entry, i) => {
    if (!isContextArtifact(entry)) {
      throw badRequest(
        `Invalid checkpoint: artifactSnapshots[${i}] is not a valid ContextArtifact`,
      );
    }
    return entry;
  });
}

function isContextArtifact(value: unknown): value is ContextArtifact {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string") return false;
  if (typeof entry.mountPath !== "string") return false;
  if (entry.version !== undefined && typeof entry.version !== "string") {
    return false;
  }
  return true;
}
