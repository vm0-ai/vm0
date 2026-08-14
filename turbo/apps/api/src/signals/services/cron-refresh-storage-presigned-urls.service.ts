import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  refreshDueReadOnlyStoragePresignedUrls,
  refreshDueWorkflowSkillStoragePresignedUrls,
  refreshDueSystemStoragePresignedUrls,
  SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
  READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  READ_ONLY_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
} from "./system-storage-presigned-url-cache.service";

export const refreshStoragePresignedUrls$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [system, workflowSkill, readOnly] = await Promise.all([
      refreshDueSystemStoragePresignedUrls(
        {
          db,
          get,
          limit: SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
          pruneLimit: SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
        },
        signal,
      ),
      refreshDueWorkflowSkillStoragePresignedUrls(
        {
          db,
          get,
          limit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
          pruneLimit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
        },
        signal,
      ),
      refreshDueReadOnlyStoragePresignedUrls(
        {
          db,
          get,
          limit: READ_ONLY_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
          pruneLimit: READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();
    return { system, workflowSkill, readOnly };
  },
);
