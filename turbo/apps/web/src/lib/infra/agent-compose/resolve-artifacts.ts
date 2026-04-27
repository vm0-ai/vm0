import {
  expandMountPath,
  WORKING_DIR_TEMPLATE,
} from "@vm0/core/variable-expander";
import { extractWorkingDir } from "../run/utils/extract-working-dir";
import { badRequest } from "@vm0/api-services/errors";
import type { AgentComposeYaml } from "./types";

/**
 * Resolve compose-declared artifact entries into a list where every entry
 * has a concrete absolute mountPath:
 *  - explicit `mount_path` absolute path → passes through
 *  - `mount_path` = "${{ working_dir }}" → framework-derived working_dir
 *  - missing `mount_path` → framework-derived working_dir (backward compat)
 *
 * This PR is purely additive — no downstream consumer calls this helper yet.
 * Wave 2 of epic #10906 will wire it into the storage manifest pipeline.
 */
export function resolveComposeArtifacts(
  compose: AgentComposeYaml,
): Array<{ name: string; version?: string; mountPath: string }> {
  const entries = compose.artifacts;
  if (!entries || entries.length === 0) {
    return [];
  }

  const workingDir = extractWorkingDir(compose);

  return entries.map((entry) => {
    const raw = entry.mount_path ?? WORKING_DIR_TEMPLATE;
    const { result, missing } = expandMountPath(raw, workingDir);
    if (missing) {
      throw badRequest(
        `Artifact "${entry.name}" uses ${WORKING_DIR_TEMPLATE} but compose has no working_dir`,
      );
    }
    return {
      name: entry.name,
      version: entry.version,
      mountPath: result,
    };
  });
}
