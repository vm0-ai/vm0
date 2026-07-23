import type { ContextArtifact, PersistedStorageMount } from "@vm0/db/types";
import { SYSTEM_ORG_ID } from "@vm0/core/storage-names";

interface LegacyVolumeVersionsSnapshot {
  readonly versions: Record<string, string>;
}

interface LegacyCheckpointStorageProjection {
  readonly artifactSnapshots: readonly ContextArtifact[] | null;
  readonly artifactVersions: Record<string, string> | null;
  readonly volumeVersionsSnapshot: LegacyVolumeVersionsSnapshot | null;
}

export function projectLegacyWritebackArtifacts(
  mounts: readonly PersistedStorageMount[],
): readonly ContextArtifact[] {
  return mounts.flatMap((mount) => {
    if (!mount.writeback) {
      return [];
    }
    return [
      {
        name: mount.name,
        ...(mount.version === undefined ? {} : { version: mount.version }),
        mountPath: mount.mountPath,
        ...(mount.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: mount.missingRootPolicy }),
      },
    ];
  });
}

/**
 * Keeps legacy checkpoint and run-result response shapes available without
 * persisting a second Storage representation for new checkpoints.
 */
export function projectLegacyCheckpointStorage(
  mounts: readonly PersistedStorageMount[],
): LegacyCheckpointStorageProjection {
  const artifactSnapshots: ContextArtifact[] = [];
  const artifactVersions: Record<string, string> = {};
  const volumeVersions: Record<string, string> = {};

  for (const mount of mounts) {
    if (mount.version === undefined) {
      throw new Error(
        `Invalid canonical checkpoint Storage "${mount.name}": missing version`,
      );
    }
    if (mount.writeback) {
      artifactSnapshots.push({
        name: mount.name,
        version: mount.version,
        mountPath: mount.mountPath,
        ...(mount.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: mount.missingRootPolicy }),
      });
      artifactVersions[mount.name] = mount.version;
      continue;
    }
    // Legacy checkpoint and run-result payloads reported user volume state,
    // not internal system Storage or resolved instruction mounts.
    if (
      mount.orgId === SYSTEM_ORG_ID ||
      mount.instructionsTargetFilename !== undefined
    ) {
      continue;
    }
    volumeVersions[mount.name] = mount.version;
  }

  return {
    artifactSnapshots:
      artifactSnapshots.length === 0 ? null : artifactSnapshots,
    artifactVersions:
      Object.keys(artifactVersions).length === 0 ? null : artifactVersions,
    volumeVersionsSnapshot:
      Object.keys(volumeVersions).length === 0
        ? null
        : { versions: volumeVersions },
  };
}
