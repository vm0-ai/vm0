import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import {
  refreshDueReadOnlyStoragePresignedUrls$,
  refreshDuePresentationTemplatePreviewPresignedUrls$,
  refreshDueWorkflowSkillStoragePresignedUrls$,
  refreshDueSystemStoragePresignedUrls$,
  SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
  READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  READ_ONLY_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
  PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT,
  PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_REFRESH_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
} from "./system-storage-presigned-url-cache.service";

export const refreshStoragePresignedUrls$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [system, workflowSkill, readOnly, presentationTemplatePreview] =
      await Promise.all([
        set(
          refreshDueSystemStoragePresignedUrls$,
          {
            db,
            limit: SYSTEM_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
            pruneLimit: SYSTEM_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
        set(
          refreshDueWorkflowSkillStoragePresignedUrls$,
          {
            db,
            limit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
            pruneLimit: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
        set(
          refreshDueReadOnlyStoragePresignedUrls$,
          {
            db,
            limit: READ_ONLY_STORAGE_PRESIGNED_URL_REFRESH_LIMIT,
            pruneLimit: READ_ONLY_STORAGE_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
        set(
          refreshDuePresentationTemplatePreviewPresignedUrls$,
          {
            db,
            limit: PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_REFRESH_LIMIT,
            pruneLimit: PRESENTATION_TEMPLATE_PREVIEW_PRESIGNED_URL_PRUNE_LIMIT,
          },
          signal,
        ),
      ]);
    signal.throwIfAborted();
    return { system, workflowSkill, readOnly, presentationTemplatePreview };
  },
);
