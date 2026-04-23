import { badRequest } from "../../shared/errors";
import type { ContextArtifact } from "../run/types";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  AUTO_MEMORY_MOUNT_PATH,
} from "../storage/types";

/**
 * Decoders for the `checkpoints.artifact_snapshots` JSONB column.
 *
 * The column accepts two shapes (see #10909 for the reader-tolerance rollout
 * and #10911 for the writer flip):
 *
 * - Legacy: `Record<name, version>` — pre-#10911 guest-agent payloads. No
 *   mountPath, so readers that need one stamp it via a name heuristic
 *   ("memory" → AUTO_MEMORY_MOUNT_PATH, anything else → workingDir).
 * - Canonical: `Array<{name, version, mountPath}>` — post-#10911 payloads.
 *   Carries the mount path per entry; no heuristics required.
 *
 * All runtime validation lives here so malformed historical rows fail fast
 * with a descriptive error rather than surfacing much later as an opaque
 * mount failure.
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
 * by `resolve-checkpoint.ts` (and any other code path that needs mountPath
 * stamped on every entry). Legacy entries get their mountPath via the name
 * heuristic.
 */
export function decodeToContextArtifacts(
  raw: unknown,
  workingDir: string,
): ContextArtifact[] {
  if (raw === null || raw === undefined) return [];

  if (Array.isArray(raw)) {
    return raw.map((entry, i) => {
      if (!isContextArtifact(entry)) {
        throw badRequest(
          `Invalid checkpoint: artifactSnapshots[${i}] is not a valid ContextArtifact`,
        );
      }
      return entry;
    });
  }

  if (typeof raw !== "object") {
    throw badRequest(
      "Invalid checkpoint: artifactSnapshots must be an array or object",
    );
  }

  return Object.entries(raw as Record<string, unknown>).map(
    ([name, version]) => {
      if (typeof version !== "string") {
        throw badRequest(
          `Invalid checkpoint: artifactSnapshots["${name}"] must be a string version`,
        );
      }
      return {
        name,
        version,
        mountPath:
          name === AUTO_MEMORY_ARTIFACT_NAME
            ? AUTO_MEMORY_MOUNT_PATH
            : workingDir,
      };
    },
  );
}

/**
 * Project the JSONB column to a `Record<name, version>` for outbound surfaces
 * that currently speak the legacy shape (e.g., `RunResult.artifact`, the CLI
 * `GET /api/agent/checkpoints/:id` response arm). mountPath is discarded; a
 * name collision in the array shape — which should never happen for a
 * well-formed snapshot — lets the last entry win, matching Object-literal
 * semantics.
 *
 * Returns `null` when the payload is empty (see `isEmptyArtifactPayload`).
 */
export function decodeToRecord(raw: unknown): Record<string, string> | null {
  if (isEmptyArtifactPayload(raw)) return null;

  if (Array.isArray(raw)) {
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

  if (typeof raw !== "object" || raw === null) {
    throw badRequest(
      "Invalid checkpoint: artifactSnapshots must be an array or object",
    );
  }

  const obj = raw as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(obj)) {
    if (typeof version !== "string") {
      throw badRequest(
        `Invalid checkpoint: artifactSnapshots["${name}"] must be a string version`,
      );
    }
    result[name] = version;
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
