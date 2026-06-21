import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@vm0/core/zero-workflow-skill";
import type { ZeroWorkflowUpdateRequest } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./zero-workflow-volume.service";
import type { WorkflowRow } from "./zero-workflow-data.service";

interface UpdateZeroWorkflowInput {
  readonly workflow: WorkflowRow;
  readonly body: ZeroWorkflowUpdateRequest;
}

export const updateZeroWorkflow$ = command(
  async (
    { get, set },
    args: UpdateZeroWorkflowInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const { workflow, body } = args;

    const nextInstruction =
      body.instruction !== undefined ? body.instruction : workflow.instruction;
    const nextDescription =
      body.description !== undefined ? body.description : workflow.description;

    // DB is the source of truth; persist column changes first.
    await writeDb
      .update(zeroWorkflows)
      .set({
        ...(body.displayName !== undefined && {
          displayName: body.displayName,
        }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.instruction !== undefined && {
          instruction: body.instruction,
        }),
        updatedAt: nowDate(),
      })
      .where(eq(zeroWorkflows.id, workflow.id));
    signal.throwIfAborted();

    // Rebuild the volume whenever the synthesized SKILL.md or the attached
    // files change. The volume is fully derived: SKILL.md + attached files.
    const skillChanged =
      body.instruction !== undefined || body.description !== undefined;
    if (body.files !== undefined || skillChanged) {
      const attachedFiles =
        body.files !== undefined
          ? body.files.map((file) => {
              return { path: file.path, content: file.content };
            })
          : (
              (await loadWorkflowVolumeFiles(get, {
                orgId: workflow.orgId,
                workflowId: workflow.id,
              })) ?? []
            )
              .filter((file) => {
                return file.path !== SKILL_FILENAME;
              })
              .map((file) => {
                return { path: file.path, content: file.content };
              });
      signal.throwIfAborted();

      const skillMd = synthesizeWorkflowSkillMd({
        name: workflow.name,
        description: nextDescription,
        instruction: nextInstruction,
      });

      await set(
        uploadVolumeServerSide$,
        {
          orgId: workflow.orgId,
          storageName: getCustomSkillStorageName(workflow.id),
          files: [{ path: SKILL_FILENAME, content: skillMd }, ...attachedFiles],
        },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);
