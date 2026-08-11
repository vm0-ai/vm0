import { command } from "ccstate";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@vm0/core/storage-names";
import { synthesizeSkillMd } from "@vm0/core/zero-workflow-skill";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
} from "./storage-volume-publication.service";
import {
  computeContentHashFromHashes,
  hashFileContent,
} from "./storage-content-hash.service";
import { SKILL_FILENAME } from "./zero-workflow-volume.service";

export interface CustomConnectorSkillContentInput {
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

export function computeCustomConnectorSkillVersionId(
  storageId: string,
  args: CustomConnectorSkillContentInput,
): string {
  const files = buildCustomConnectorSkillFiles(args).map((file) => {
    const content = Buffer.from(file.content, "utf8");
    return {
      path: file.path,
      hash: hashFileContent(content),
      size: content.length,
    };
  });
  return computeContentHashFromHashes(storageId, files);
}

export const prepareCustomConnectorSkillVolume$ = command(
  async (
    { set },
    args: PrepareCustomConnectorSkillVolumeInput,
    signal: AbortSignal,
  ): Promise<PreparedServerSideVolume> => {
    const volume = await set(
      prepareVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getCustomConnectorSkillStorageName(args.connectorId),
        files: buildCustomConnectorSkillFiles(args),
      },
      signal,
    );
    signal.throwIfAborted();
    return volume;
  },
);

export async function commitPreparedCustomConnectorSkillVolume(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly volume: PreparedServerSideVolume;
  },
  signal: AbortSignal,
): Promise<void> {
  await commitPreparedVolumeServerSide(
    { db: args.db, volume: args.volume },
    signal,
  );
  await args.db
    .update(orgCustomConnectors)
    .set({ skillStorageVersionId: args.volume.version.versionId })
    .where(eq(orgCustomConnectors.id, args.connectorId));
  signal.throwIfAborted();
}
