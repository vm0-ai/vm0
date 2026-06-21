import { computed, type Computed } from "ccstate";
import type {
  WorkflowFileEntry,
  WorkflowFileMetadata,
  ZeroWorkflowDetailResponse,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { db$ } from "../external/db";
import {
  loadVisibleWorkflowById,
  workflowSummary,
  type WorkflowMember,
} from "./zero-workflow-data.service";
import {
  loadWorkflowVolumeFiles,
  SKILL_FILENAME,
} from "./zero-workflow-volume.service";
import { loadWorkflowTriggers } from "./zero-workflow-trigger.service";

export function zeroWorkflowDetail(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
}): Computed<Promise<ZeroWorkflowDetailResponse | null>> {
  return computed(async (get): Promise<ZeroWorkflowDetailResponse | null> => {
    const db = get(db$);
    const visible = await loadVisibleWorkflowById(db, {
      orgId: args.orgId,
      member: args.member,
      workflowId: args.workflowId,
    });

    if (!visible) {
      return null;
    }
    const { workflow, agent } = visible;

    const summary = workflowSummary({ workflow, agent, member: args.member });

    // The synthesized SKILL.md is derived from the DB instruction; users never
    // see it in the file list, so exclude it from both files and fileContents.
    // A `null` volume (no backing storage, or its objects are missing) surfaces
    // as `null` files/fileContents, distinct from an empty-but-loaded volume.
    const loadedVolume = await loadWorkflowVolumeFiles(get, {
      orgId: args.orgId,
      workflowId: workflow.id,
    });
    const volumeFiles = loadedVolume?.filter((file) => {
      return file.path !== SKILL_FILENAME;
    });

    const files: WorkflowFileMetadata[] | null =
      volumeFiles?.map((file) => {
        return { path: file.path, size: file.size };
      }) ?? null;
    const fileContents: WorkflowFileEntry[] | null =
      volumeFiles?.map((file) => {
        return { path: file.path, content: file.content };
      }) ?? null;

    const triggers = await loadWorkflowTriggers(db, {
      orgId: args.orgId,
      workflowId: workflow.id,
      userId: args.member.userId,
    });

    return {
      ...summary,
      instruction: workflow.instruction,
      files,
      fileContents,
      triggers: [...triggers],
    };
  });
}
