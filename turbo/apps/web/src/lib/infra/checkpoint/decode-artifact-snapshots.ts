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
 * Is `raw` a "no artifacts" payload? Treats null/undefined, empty record, and
 * empty array all as equivalent to "persist NULL." Exported so write-paths
 * can normalise before inserting to the JSONB column without needing to know
 * which shape the caller sent.
 */
export function isEmptyArtifactPayload(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === "object") return Object.keys(raw).length === 0;
  return false;
}

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

/**
 * Project the JSONB column to a `Record<name, version>` for outbound surfaces
 * that currently speak the legacy shape (e.g., `RunResult.artifact`, the CLI
 * `GET /api/agent/checkpoints/:id` response arm). mountPath is discarded; a
 * name collision — which should never happen for a well-formed snapshot —
 * lets the last entry win, matching Object-literal semantics.
 *
 * Returns `null` when the payload is empty (see `isEmptyArtifactPayload`).
 */
export function decodeToRecord(raw: unknown): Record<string, string> | null {
  if (isEmptyArtifactPayload(raw)) return null;

  if (!Array.isArray(raw)) {
    throw badRequest("Invalid checkpoint: artifactSnapshots must be an array");
  }

  const result: Record<string, string> = {};
  for (const [i, entry] of raw.entries()) {
    if (!isContextArtifact(entry)) {
      throw badRequest(
        `Invalid checkpoint: artifactSnapshots[${i}] is not a valid ContextArtifact`,
      );
    }
    if (entry.version === undefined) {
      throw badRequest(
        `Invalid checkpoint: artifactSnapshots[${i}] has no version`,
      );
    }
    result[entry.name] = entry.version;
  }
  return result;
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
