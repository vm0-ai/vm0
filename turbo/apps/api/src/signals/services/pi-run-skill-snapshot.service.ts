import { createHash } from "node:crypto";

import {
  PI_SKILLS_ROOT,
  type RunSkillSnapshot,
  type RunSkillSnapshotEntry,
} from "@vm0/api-contracts/contracts/runners";
import type { PersistedStorageMount } from "@vm0/db/types";

import type { StorageManifestSource } from "./agent-run-storage.service";

const RUN_SKILL_SNAPSHOT_SCHEMA_VERSION = 1;
const RUN_SKILL_SNAPSHOT_POLICY_VERSION = 1;

function isSkillSource(source: StorageManifestSource): boolean {
  return (
    source === "system_skill" ||
    source === "connector_skill" ||
    source === "custom_connector_skill" ||
    source === "workflow_skill"
  );
}

interface SkillSlotVolume {
  readonly mountPath: string;
}

function skillSlotPaths(args: {
  readonly additionalVolumes: readonly SkillSlotVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
}): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const [index, volume] of (args.additionalVolumes ?? []).entries()) {
    const source = args.additionalVolumeSources?.[index];
    if (source !== undefined && isSkillSource(source)) {
      paths.add(volume.mountPath);
    }
  }
  return paths;
}

function snapshotEntry(mount: PersistedStorageMount): RunSkillSnapshotEntry {
  if (mount.version === undefined) {
    throw new Error(
      `Resolved Pi Skill mount "${mount.mountPath}" has no exact version`,
    );
  }
  return {
    logicalDir: mount.mountPath,
    skillFile: `${mount.mountPath}/SKILL.md`,
    orgId: mount.orgId,
    userId: mount.userId,
    storageName: mount.name,
    storageId: mount.storageId,
    versionId: mount.version,
  };
}

function snapshotDigest(entries: readonly RunSkillSnapshotEntry[]): string {
  const identityTuple = [
    RUN_SKILL_SNAPSHOT_SCHEMA_VERSION,
    RUN_SKILL_SNAPSHOT_POLICY_VERSION,
    PI_SKILLS_ROOT,
    ...entries.map((entry) => {
      return [
        entry.logicalDir,
        entry.skillFile,
        entry.orgId,
        entry.userId,
        entry.storageName,
        entry.storageId,
        entry.versionId,
      ];
    }),
  ];
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(identityTuple))
    .digest("hex")}`;
}

/**
 * Projects the final, last-wins Storage tree into the immutable Skill view for
 * one Pi run. Slot membership comes from the original Skill sources, while
 * entry identity comes from the final winner mount at each slot.
 */
export function buildRunSkillSnapshot(args: {
  readonly additionalVolumes: readonly SkillSlotVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
}): RunSkillSnapshot {
  const slots = skillSlotPaths(args);
  const entries = args.persistedStorageMounts
    .filter((mount) => {
      return slots.has(mount.mountPath);
    })
    .map(snapshotEntry);
  return {
    schemaVersion: RUN_SKILL_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: RUN_SKILL_SNAPSHOT_POLICY_VERSION,
    root: PI_SKILLS_ROOT,
    digest: snapshotDigest(entries),
    entries,
  };
}
