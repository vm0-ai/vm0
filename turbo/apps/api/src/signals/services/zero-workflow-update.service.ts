import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import type { ZeroWorkflowUpdateRequest } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import type { WorkflowRow } from "./zero-workflow-data.service";

interface UpdateZeroWorkflowInput {
  readonly workflow: WorkflowRow;
  readonly body: ZeroWorkflowUpdateRequest;
}

interface UpdatedZeroWorkflowContent {
  readonly content: string | null;
  readonly files:
    | readonly { readonly path: string; readonly size: number }[]
    | null;
}

export const updateZeroWorkflow$ = command(
  async (
    { set },
    args: UpdateZeroWorkflowInput,
    signal: AbortSignal,
  ): Promise<UpdatedZeroWorkflowContent> => {
    const writeDb = set(writeDb$);

    if (args.body.files) {
      await set(
        uploadVolumeServerSide$,
        {
          orgId: args.workflow.orgId,
          storageName: getCustomSkillStorageName(args.workflow.name),
          files: args.body.files,
        },
        signal,
      );
      signal.throwIfAborted();
    }

    await writeDb
      .update(zeroWorkflows)
      .set({
        ...(args.body.displayName !== undefined && {
          displayName: args.body.displayName,
        }),
        ...(args.body.description !== undefined && {
          description: args.body.description,
        }),
        ...(args.body.visibility !== undefined && {
          visibility: args.body.visibility,
        }),
        updatedAt: nowDate(),
      })
      .where(eq(zeroWorkflows.id, args.workflow.id));
    signal.throwIfAborted();

    const skillFile = args.body.files?.find((file) => {
      return file.path === "SKILL.md";
    });

    return {
      content: skillFile?.content ?? null,
      files:
        args.body.files?.map((file) => {
          return {
            path: file.path,
            size: Buffer.byteLength(file.content, "utf8"),
          };
        }) ?? null,
    };
  },
);
