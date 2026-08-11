import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { presentationTemplates } from "@vm0/db/schema/presentation-template";
import { eq } from "drizzle-orm";

import { conflict, badRequestMessage, notFound } from "../../lib/error";
import { isUniqueViolation } from "../../lib/pg-errors";
import { templateImportPrompt } from "../../lib/template-import-prompt";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { onRejection, settle } from "../utils";
import { createAgentRun$ } from "./agent-run-create.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { resolveArtifactObject$ } from "./artifact-storage.service";
import {
  loadOwnedPresentationTemplate,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "./presentation-template-data.service";
import { preflightPresentationTemplate$ } from "./presentation-template-preflight.service";

interface CreatePresentationTemplateInput {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly body: {
    readonly uploadId: string;
    readonly filename: string;
    readonly contentType: string;
  };
}

function normalizedContentType(contentType: string): string {
  const separator = contentType.indexOf(";");
  return (separator === -1 ? contentType : contentType.slice(0, separator))
    .trim()
    .toLowerCase();
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension || filename;
}

function preflightError(code: string, message: string) {
  return {
    status: 400 as const,
    body: { error: { code, message } },
  };
}

const resolvePresentationTemplateSource$ = command(
  async (
    { set },
    args: CreatePresentationTemplateInput,
    signal: AbortSignal,
  ) => {
    const source = await set(
      resolveArtifactObject$,
      { userId: args.ownerUserId, id: args.body.uploadId },
      signal,
    );
    if (!source) {
      return {
        response: notFound(`Uploaded file not found: ${args.body.uploadId}`),
      };
    }
    if (
      source.filename !== args.body.filename ||
      normalizedContentType(source.contentType) !==
        normalizedContentType(args.body.contentType)
    ) {
      return {
        response: badRequestMessage(
          "Uploaded file metadata does not match the create request",
        ),
      };
    }
    const preflight = await set(
      preflightPresentationTemplate$,
      { source },
      signal,
    );
    return preflight.ok
      ? { source }
      : { response: preflightError(preflight.code, preflight.message) };
  },
);

async function insertPendingPresentationTemplate(
  db: Db,
  args: CreatePresentationTemplateInput & {
    readonly source: {
      readonly key: string;
      readonly filename: string;
    };
  },
  signal: AbortSignal,
): Promise<
  | { readonly row: PresentationTemplateRow }
  | { readonly response: ReturnType<typeof conflict> }
> {
  const currentTime = nowDate();
  const insertion = await settle(
    db
      .insert(presentationTemplates)
      .values({
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        title: titleFromFilename(args.source.filename),
        sourceStorageKey: args.source.key,
        sourceFilename: args.source.filename,
        createdBy: args.ownerUserId,
        updatedBy: args.ownerUserId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning(),
    signal,
  );
  if (!insertion.ok) {
    if (isUniqueViolation(insertion.error)) {
      return {
        response: conflict(
          "A presentation template import is already in progress",
        ),
      };
    }
    throw insertion.error;
  }
  const row = insertion.value[0];
  if (!row) {
    throw new Error("Failed to insert presentation template");
  }
  return { row };
}

async function deleteUnlaunchedTemplate(db: Db, templateId: string) {
  await db
    .delete(presentationTemplates)
    .where(eq(presentationTemplates.id, templateId));
}

export const createPresentationTemplate$ = command(
  async (
    { set },
    args: CreatePresentationTemplateInput,
    signal: AbortSignal,
  ) => {
    const sourceResult = await set(
      resolvePresentationTemplateSource$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if ("response" in sourceResult) {
      return sourceResult.response;
    }
    const db = set(writeDb$);
    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!metadata?.defaultAgentId) {
      return conflict(
        "A default agent must be configured before importing a template",
      );
    }
    const inserted = await insertPendingPresentationTemplate(
      db,
      { ...args, source: sourceResult.source },
      signal,
    );
    if ("response" in inserted) {
      return inserted.response;
    }
    const runResult = await onRejection(
      set(
        createAgentRun$,
        {
          userId: args.ownerUserId,
          orgId: args.orgId,
          body: {
            agentComposeId: metadata.defaultAgentId,
            prompt: templateImportPrompt(inserted.row.id),
            triggerSource: "template-import",
            vars: { PRESENTATION_TEMPLATE_ID: inserted.row.id },
          },
          apiStartTime: now(),
          callbacks: [
            {
              internalKind: "presentation-template:import",
              payload: { templateId: inserted.row.id },
            },
          ],
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          includeZeroTokenSecret: true,
          connectorScope: {
            allowedConnectorSlugs: [],
            allowedCustomConnectorIds: [],
            source: "explicit",
          },
          validateEnvironmentReferences: false,
          queueOnConcurrencyLimit: true,
          enforceVm0Credits: true,
        },
        signal,
      ),
      async () => {
        await deleteUnlaunchedTemplate(db, inserted.row.id);
      },
    );
    signal.throwIfAborted();
    if (runResult.status !== 201) {
      await deleteUnlaunchedTemplate(db, inserted.row.id);
      signal.throwIfAborted();
      return runResult;
    }
    const current =
      runResult.body.status === "failed"
        ? await loadOwnedPresentationTemplate(db, {
            orgId: args.orgId,
            ownerUserId: args.ownerUserId,
            templateId: inserted.row.id,
          })
        : inserted.row;
    return {
      status: 201 as const,
      body: presentationTemplateSummary(current ?? inserted.row),
    };
  },
);
