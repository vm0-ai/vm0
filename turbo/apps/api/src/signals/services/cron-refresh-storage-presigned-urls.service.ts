import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  refreshDueWorkflowSkillStoragePresignedUrls,
  refreshDueSystemStoragePresignedUrls,
  SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
} from "./system-storage-presigned-url-cache.service";

export const refreshStoragePresignedUrls$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [system, workflowSkill] = await Promise.all([
      refreshDueSystemStoragePresignedUrls({
        db,
        get,
        signal,
        limit: SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
        pruneLimit: SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
      }),
      refreshDueWorkflowSkillStoragePresignedUrls({
        db,
        get,
        signal,
        limit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
        pruneLimit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
      }),
    ]);
    signal.throwIfAborted();
    return { system, workflowSkill };
  },
);
