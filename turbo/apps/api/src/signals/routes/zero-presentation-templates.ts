import { command, computed } from "ccstate";
import { zeroPresentationTemplatesContract } from "@vm0/api-contracts/contracts/zero-presentation-templates";
import { getPresentationTemplateStorageName } from "@vm0/core/storage-names";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { presentationTemplates } from "@vm0/db/schema/presentation-template";
import { and, eq, inArray } from "drizzle-orm";

import { env } from "../../lib/env";
import { conflict, badRequestMessage, notFound } from "../../lib/error";
import { buildFileUrlFromKey } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { isUniqueViolation } from "../../lib/pg-errors";
import { templateImportPrompt } from "../../lib/template-import-prompt";
import { now, nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  s3MetadataHeaders,
  s3ObjectHead,
} from "../external/s3";
import {
  allocateArtifactObject$,
  artifactObjectMetadata,
  resolveArtifactObject$,
} from "../services/artifact-storage.service";
import { createAgentRun$ } from "../services/agent-run-create.service";
import { deletePresentationTemplate$ } from "../services/presentation-template-delete.service";
import {
  listOwnedPresentationTemplates,
  loadOwnedPresentationTemplate,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "../services/presentation-template-data.service";
import { preflightPresentationTemplate$ } from "../services/presentation-template-preflight.service";
import { uploadVolumeServerSide$ } from "../services/storage-volume-upload.service";
import type { RouteEntry } from "../route-entry";
import { onRejection, settle } from "../utils";

const PRESIGNED_URL_TTL_SECONDS = 15 * 60;
const PAGE_CONTENT_TYPE = "image/png";

const templateReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const templateWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

const templateRunReadAuth = {
  accept: ["zero", "sandbox"],
  acceptAnySandboxCapability: true,
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "presentation-template:read",
} as const;

const templateRunWriteAuth = {
  accept: ["zero", "sandbox"],
  acceptAnySandboxCapability: true,
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "presentation-template:write",
} as const;

function templateNotFound(templateId: string) {
  return notFound(`Presentation template not found: ${templateId}`);
}

function preflightError(code: string, message: string) {
  return {
    status: 400 as const,
    body: { error: { code, message } },
  };
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension || filename;
}

function normalizedContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function pageFilename(index: number): string {
  return `page-${(index + 1).toString().padStart(3, "0")}.png`;
}

function activeImportError(row: PresentationTemplateRow) {
  return row.status === "pending" || row.status === "processing"
    ? null
    : conflict(`Presentation template import is already ${row.status}`);
}

const listInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const rows = await listOwnedPresentationTemplates(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
  });
  return {
    status: 200 as const,
    body: rows.map(presentationTemplateSummary),
  };
});

const createBody$ = bodyResultOf(zeroPresentationTemplatesContract.create);
const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(createBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const source = await set(
    resolveArtifactObject$,
    { userId: auth.userId, id: body.uploadId },
    signal,
  );
  if (!source) {
    return notFound(`Uploaded file not found: ${body.uploadId}`);
  }
  if (
    source.filename !== body.filename ||
    normalizedContentType(source.contentType) !==
      normalizedContentType(body.contentType)
  ) {
    return badRequestMessage(
      "Uploaded file metadata does not match the create request",
    );
  }

  const preflight = await set(
    preflightPresentationTemplate$,
    { source },
    signal,
  );
  if (!preflight.ok) {
    return preflightError(preflight.code, preflight.message);
  }

  const writeDb = set(writeDb$);
  const [metadata] = await writeDb
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, auth.orgId))
    .limit(1);
  signal.throwIfAborted();
  if (!metadata?.defaultAgentId) {
    return conflict(
      "A default agent must be configured before importing a template",
    );
  }

  const currentTime = nowDate();
  const insertion = await settle(
    writeDb
      .insert(presentationTemplates)
      .values({
        orgId: auth.orgId,
        ownerUserId: auth.userId,
        title: titleFromFilename(source.filename),
        sourceStorageKey: source.key,
        sourceFilename: source.filename,
        createdBy: auth.userId,
        updatedBy: auth.userId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning(),
    signal,
  );
  if (!insertion.ok) {
    if (isUniqueViolation(insertion.error)) {
      return conflict("A presentation template import is already in progress");
    }
    throw insertion.error;
  }
  const inserted = insertion.value[0];
  if (!inserted) {
    throw new Error("Failed to insert presentation template");
  }

  const runResult = await onRejection(
    set(
      createAgentRun$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        body: {
          agentComposeId: metadata.defaultAgentId,
          prompt: templateImportPrompt(inserted.id),
          triggerSource: "template-import",
          vars: { PRESENTATION_TEMPLATE_ID: inserted.id },
        },
        apiStartTime: now(),
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
      await writeDb
        .delete(presentationTemplates)
        .where(eq(presentationTemplates.id, inserted.id));
    },
  );
  signal.throwIfAborted();
  if (runResult.status !== 201) {
    await writeDb
      .delete(presentationTemplates)
      .where(eq(presentationTemplates.id, inserted.id));
    signal.throwIfAborted();
    return runResult;
  }
  return { status: 201 as const, body: presentationTemplateSummary(inserted) };
});

const getParams$ = pathParamsOf(zeroPresentationTemplatesContract.get);
const getInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(getParams$);
  const row = await loadOwnedPresentationTemplate(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId: params.templateId,
  });
  if (!row) {
    return templateNotFound(params.templateId);
  }
  return {
    status: 200 as const,
    body: {
      ...presentationTemplateSummary(row),
      pageUrls: row.pageKeys.map(buildFileUrlFromKey),
    },
  };
});

const updateParams$ = pathParamsOf(zeroPresentationTemplatesContract.update);
const updateBody$ = bodyResultOf(zeroPresentationTemplatesContract.update);
const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(updateParams$);
  const bodyResult = await get(updateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const [row] = await set(writeDb$)
    .update(presentationTemplates)
    .set({
      title: bodyResult.data.title,
      updatedAt: nowDate(),
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(presentationTemplates.id, params.templateId),
        eq(presentationTemplates.orgId, auth.orgId),
        eq(presentationTemplates.ownerUserId, auth.userId),
      ),
    )
    .returning();
  signal.throwIfAborted();
  return row
    ? { status: 200 as const, body: presentationTemplateSummary(row) }
    : templateNotFound(params.templateId);
});

const deleteParams$ = pathParamsOf(zeroPresentationTemplatesContract.delete);
const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(deleteParams$);
  const deleted = await set(
    deletePresentationTemplate$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: params.templateId,
    },
    signal,
  );
  return deleted
    ? { status: 204 as const, body: undefined }
    : templateNotFound(params.templateId);
});

const sourceParams$ = pathParamsOf(zeroPresentationTemplatesContract.source);
const sourceInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(sourceParams$);
  const row = await loadOwnedPresentationTemplate(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId: params.templateId,
  });
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const head = await get(s3ObjectHead(bucket, row.sourceStorageKey));
  if (head.kind === "missing" || head.contentLength === undefined) {
    return notFound("Presentation template source file not found");
  }
  const url = await get(
    generatePresignedGetUrl(
      bucket,
      row.sourceStorageKey,
      PRESIGNED_URL_TTL_SECONDS,
      row.sourceFilename,
      true,
    ),
  );
  return {
    status: 200 as const,
    body: {
      url,
      filename: row.sourceFilename,
      contentType: head.contentType ?? inferMimetype(row.sourceFilename),
      size: head.contentLength,
    },
  };
});

const preparePagesParams$ = pathParamsOf(
  zeroPresentationTemplatesContract.preparePages,
);
const preparePagesBody$ = bodyResultOf(
  zeroPresentationTemplatesContract.preparePages,
);
const preparePagesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(preparePagesParams$);
    const bodyResult = await get(preparePagesBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const row = await loadOwnedPresentationTemplate(get(db$), {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: params.templateId,
    });
    signal.throwIfAborted();
    if (!row) {
      return templateNotFound(params.templateId);
    }
    const stateError = activeImportError(row);
    if (stateError) {
      return stateError;
    }

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const uploads = await Promise.all(
      Array.from({ length: bodyResult.data.count }, async (_, index) => {
        const filename = pageFilename(index);
        const artifact = await set(
          allocateArtifactObject$,
          {
            userId: auth.userId,
            id: row.id,
            variant: `page-${index.toString()}`,
            filename,
          },
          signal,
        );
        const uploadUrl = await get(
          generatePresignedPutUrl(
            bucket,
            artifact.key,
            PAGE_CONTENT_TYPE,
            PRESIGNED_URL_TTL_SECONDS,
            { usePublicEndpoint: true, metadata: artifact.metadata },
          ),
        );
        return {
          key: artifact.key,
          uploadUrl,
          uploadHeaders: s3MetadataHeaders(artifact.metadata),
        };
      }),
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { uploads } };
  },
);

const commitPagesParams$ = pathParamsOf(
  zeroPresentationTemplatesContract.commitPages,
);
const commitPagesBody$ = bodyResultOf(
  zeroPresentationTemplatesContract.commitPages,
);
const commitPagesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(commitPagesParams$);
  const bodyResult = await get(commitPagesBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const row = await loadOwnedPresentationTemplate(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId: params.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const stateError = activeImportError(row);
  if (stateError) {
    return stateError;
  }
  const { keys } = bodyResult.data;
  if (new Set(keys).size !== keys.length) {
    return badRequestMessage("Page image keys must be unique");
  }

  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const validPages = await Promise.all(
    keys.map(async (key, index) => {
      const head = await get(s3ObjectHead(bucket, key));
      if (head.kind === "missing" || head.contentType !== PAGE_CONTENT_TYPE) {
        return false;
      }
      const expected = artifactObjectMetadata(
        auth.userId,
        row.id,
        pageFilename(index),
      );
      return Object.entries(expected).every(([name, value]) => {
        return head.metadata[name] === value;
      });
    }),
  );
  signal.throwIfAborted();
  if (
    validPages.some((valid) => {
      return !valid;
    })
  ) {
    return badRequestMessage("One or more page image uploads are invalid");
  }

  const [updated] = await set(writeDb$)
    .update(presentationTemplates)
    .set({
      pageKeys: keys,
      aspectRatio: bodyResult.data.aspectRatio,
      status: "processing",
      error: null,
      updatedAt: nowDate(),
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(presentationTemplates.id, row.id),
        eq(presentationTemplates.orgId, auth.orgId),
        eq(presentationTemplates.ownerUserId, auth.userId),
        inArray(presentationTemplates.status, ["pending", "processing"]),
      ),
    )
    .returning({ id: presentationTemplates.id });
  signal.throwIfAborted();
  if (!updated) {
    return templateNotFound(row.id);
  }
  return {
    status: 200 as const,
    body: { id: updated.id, status: "processing" as const },
  };
});

const packageParams$ = pathParamsOf(
  zeroPresentationTemplatesContract.publishPackage,
);
const packageBody$ = bodyResultOf(
  zeroPresentationTemplatesContract.publishPackage,
);
const packageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(packageParams$);
  const bodyResult = await get(packageBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const row = await loadOwnedPresentationTemplate(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId: params.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  if (row.status !== "processing" || row.pageKeys.length === 0) {
    return conflict(
      "Page images must be committed before publishing a package",
    );
  }
  await set(
    uploadVolumeServerSide$,
    {
      orgId: auth.orgId,
      storageName: getPresentationTemplateStorageName(row.id),
      files: bodyResult.data.files,
    },
    signal,
  );
  signal.throwIfAborted();
  const [updated] = await set(writeDb$)
    .update(presentationTemplates)
    .set({
      status: "ready",
      error: null,
      updatedAt: nowDate(),
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(presentationTemplates.id, row.id),
        eq(presentationTemplates.status, "processing"),
      ),
    )
    .returning({ id: presentationTemplates.id });
  signal.throwIfAborted();
  if (!updated) {
    return conflict("Presentation template is no longer processing");
  }
  return {
    status: 200 as const,
    body: { id: updated.id, status: "ready" as const },
  };
});

const failParams$ = pathParamsOf(zeroPresentationTemplatesContract.fail);
const failBody$ = bodyResultOf(zeroPresentationTemplatesContract.fail);
const failInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(failParams$);
  const bodyResult = await get(failBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const [updated] = await set(writeDb$)
    .update(presentationTemplates)
    .set({
      status: "failed",
      error: bodyResult.data,
      updatedAt: nowDate(),
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(presentationTemplates.id, params.templateId),
        eq(presentationTemplates.orgId, auth.orgId),
        eq(presentationTemplates.ownerUserId, auth.userId),
        inArray(presentationTemplates.status, ["pending", "processing"]),
      ),
    )
    .returning({ id: presentationTemplates.id });
  signal.throwIfAborted();
  if (updated) {
    return {
      status: 200 as const,
      body: { id: updated.id, status: "failed" as const },
    };
  }
  const row = await loadOwnedPresentationTemplate(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId: params.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  return conflict(`Presentation template import is already ${row.status}`);
});

export const zeroPresentationTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: zeroPresentationTemplatesContract.list,
    handler: authRoute(templateReadAuth, listInner$),
  },
  {
    route: zeroPresentationTemplatesContract.create,
    handler: authRoute(templateWriteAuth, createInner$),
  },
  {
    route: zeroPresentationTemplatesContract.get,
    handler: authRoute(templateReadAuth, getInner$),
  },
  {
    route: zeroPresentationTemplatesContract.update,
    handler: authRoute(templateWriteAuth, updateInner$),
  },
  {
    route: zeroPresentationTemplatesContract.delete,
    handler: authRoute(templateWriteAuth, deleteInner$),
  },
  {
    route: zeroPresentationTemplatesContract.source,
    handler: authRoute(templateRunReadAuth, sourceInner$),
  },
  {
    route: zeroPresentationTemplatesContract.preparePages,
    handler: authRoute(templateRunWriteAuth, preparePagesInner$),
  },
  {
    route: zeroPresentationTemplatesContract.commitPages,
    handler: authRoute(templateRunWriteAuth, commitPagesInner$),
  },
  {
    route: zeroPresentationTemplatesContract.publishPackage,
    handler: authRoute(templateRunWriteAuth, packageInner$),
  },
  {
    route: zeroPresentationTemplatesContract.fail,
    handler: authRoute(templateRunWriteAuth, failInner$),
  },
];
