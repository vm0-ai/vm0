import type { AdditionalVolume } from "../storage/types";
import type { VolumeVersionsSnapshot } from "./types";

export function additionalVolumesFromSnapshot(
  snapshot: VolumeVersionsSnapshot | null | undefined,
): AdditionalVolume[] | undefined {
  return snapshot?.additionalVolumes?.map((volume) => {
    return {
      name: volume.name,
      version: volume.versionId,
      mountPath: volume.mountPath,
    };
  });
}
