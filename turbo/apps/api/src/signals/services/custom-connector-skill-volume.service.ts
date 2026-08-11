import { command } from "ccstate";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@vm0/core/storage-names";
import { synthesizeSkillMd } from "@vm0/core/zero-workflow-skill";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  establishCustomConnectorSkillPublication,
  retireCustomConnectorSkillPublication,
} from "./custom-connector-skill-publication.service";
import {
  commitPreparedVolumeServerSide,
  publishStagedVolumeServerSide$,
  stageVolumeServerSide$,
  type PreparedServerSideVolume,
} from "./storage-volume-publication.service";
import { SKILL_FILENAME } from "./zero-workflow-volume.service";

interface CustomConnectorSkillContentInput {
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly displayName: string;
  readonly skillMarkdown: string;
  readonly skillName?: string;
  readonly skillDescription?: string;
}

interface PrepareCustomConnectorSkillVolumeInput extends CustomConnectorSkillContentInput {
  readonly orgId: string;
}

export interface PreparedCustomConnectorSkillVolume {
  readonly volume: PreparedServerSideVolume;
  readonly publicationCoordinated: boolean;
}

function buildCustomConnectorSkillFiles(
  args: CustomConnectorSkillContentInput,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: SKILL_FILENAME,
      content: synthesizeSkillMd({
        name:
          args.skillName ??
          getCustomConnectorSkillName(args.connectorSlug, args.connectorId),
        description: args.skillDescription ?? args.displayName,
        instruction: args.skillMarkdown,
      }),
    },
  ];
}

export const prepareCustomConnectorSkillVolume$ = command(
  async (
    { set },
    args: PrepareCustomConnectorSkillVolumeInput,
    signal: AbortSignal,
  ): Promise<PreparedCustomConnectorSkillVolume> => {
    const staged = await set(
      stageVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getCustomConnectorSkillStorageName(args.connectorId),
        files: buildCustomConnectorSkillFiles(args),
      },
      signal,
    );
    signal.throwIfAborted();
    const publicationCoordinated = staged.kind === "upload";
    if (publicationCoordinated) {
      await establishCustomConnectorSkillPublication(
        {
          db: set(writeDb$),
          volume: staged.volume,
          stateUpdatedAt: nowDate(),
        },
        signal,
      );
    }
    signal.throwIfAborted();
    const volume = await set(publishStagedVolumeServerSide$, staged, signal);
    return { volume, publicationCoordinated };
  },
);

export async function commitPreparedCustomConnectorSkillStorage(
  args: {
    readonly db: Db;
    readonly skill: PreparedCustomConnectorSkillVolume;
  },
  signal: AbortSignal,
): Promise<void> {
  await retireCustomConnectorSkillPublication(
    {
      db: args.db,
      volume: args.skill.volume,
      required: args.skill.publicationCoordinated,
    },
    signal,
  );
  await commitPreparedVolumeServerSide(
    { db: args.db, volume: args.skill.volume },
    signal,
  );
}
