import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PrepareVolumeServerSideInput,
} from "./storage-volume-publication.service";

interface UploadedVolume {
  readonly storageName: string;
  readonly versionId: string;
}

export const uploadVolumeServerSide$ = command(
  async (
    { set },
    args: PrepareVolumeServerSideInput,
    signal: AbortSignal,
  ): Promise<UploadedVolume> => {
    const volume = await set(prepareVolumeServerSide$, args, signal);
    const writeDb = set(writeDb$);
    await writeDb.transaction(async (tx) => {
      await commitPreparedVolumeServerSide({ db: tx, volume }, signal);
    });
    signal.throwIfAborted();
    return {
      storageName: volume.storageName,
      versionId: volume.version.versionId,
    };
  },
);
