import { command, createStore } from "ccstate";
import { z } from "zod";

import { writeDb$, type Db } from "../external/db";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { loadPresentationTemplateImportRun } from "./presentation-template-data.service";
import { failPresentationTemplateImport$ } from "./presentation-template-failure.service";
import { deletePresentationTemplatePages$ } from "./presentation-template-page.service";
import { cleanupPresentationTemplatePackage$ } from "./presentation-template-package.service";

const CALLBACK_TIMEOUT_MS = 30_000;
const callbackPayloadSchema = z.object({ templateId: z.uuid() });

async function cleanupDeletedPresentationTemplate(
  args: {
    readonly store: ReturnType<typeof createStore>;
    readonly orgId: string;
    readonly templateId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.store.set(
    deletePresentationTemplatePages$,
    { templateId: args.templateId, storedKeys: [] },
    signal,
  );
  await args.store.set(
    cleanupPresentationTemplatePackage$,
    { orgId: args.orgId, templateId: args.templateId },
    signal,
  );
}

export async function handlePresentationTemplateImportInternalCallback(
  db: Db,
  envelope: InternalRunCallbackEnvelope,
): Promise<InternalRunCallbackDispatchResult> {
  if (envelope.status === "progress") {
    return { success: true, skipped: true };
  }
  const payload = callbackPayloadSchema.safeParse(envelope.payload);
  if (!payload.success) {
    return {
      success: false,
      error: "Invalid presentation template import callback payload",
    };
  }
  const importRun = await loadPresentationTemplateImportRun(db, {
    runId: envelope.runId,
    templateId: payload.data.templateId,
  });
  if (!importRun) {
    return {
      success: false,
      error: "Presentation template import run association not found",
    };
  }
  if (importRun.template?.status === "ready") {
    return { success: true, skipped: true };
  }

  const store = createStore();
  const callbackSignal = AbortSignal.timeout(CALLBACK_TIMEOUT_MS);
  if (!importRun.template) {
    await cleanupDeletedPresentationTemplate(
      {
        store,
        orgId: importRun.orgId,
        templateId: payload.data.templateId,
      },
      callbackSignal,
    );
    return { success: true };
  }

  const error =
    envelope.status === "failed"
      ? {
          code: "analysis_failed",
          message: envelope.error,
        }
      : {
          code: "publish_failed",
          message:
            "Template import run completed without publishing the package",
        };
  const result = await store.set(
    failPresentationTemplateImport$,
    {
      orgId: importRun.orgId,
      ownerUserId: importRun.ownerUserId,
      templateId: payload.data.templateId,
      error,
    },
    callbackSignal,
  );
  if (result.kind === "not-found") {
    await cleanupDeletedPresentationTemplate(
      {
        store,
        orgId: importRun.orgId,
        templateId: payload.data.templateId,
      },
      callbackSignal,
    );
    return { success: true };
  }
  return result.kind === "failed"
    ? { success: true }
    : { success: true, skipped: true };
}

export const handlePresentationTemplateImportInternalCallback$ = command(
  async (
    { set },
    envelope: InternalRunCallbackEnvelope,
    _signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handlePresentationTemplateImportInternalCallback(
      set(writeDb$),
      envelope,
    );
  },
);
