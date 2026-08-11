import { command, computed } from "ccstate";
import { zeroPresentationTemplatesContract } from "@vm0/api-contracts/contracts/zero-presentation-templates";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { presentationTemplates } from "@vm0/db/schema/presentation-template";
import { and, eq, inArray } from "drizzle-orm";

import { env } from "../../lib/env";
import { conflict, badRequestMessage, notFound } from "../../lib/error";
import { buildFileUrlFromKey } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import {
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  s3MetadataHeaders,
  s3ObjectHead,
} from "../external/s3";
import { artifactObjectMetadata } from "../services/artifact-storage.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { createPresentationTemplate$ } from "../services/presentation-template-create.service";
import {
  listOwnedPresentationTemplates,
  loadOwnedPresentationTemplate,
  loadRunOwnedPresentationTemplate,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "../services/presentation-template-data.service";
import { deletePresentationTemplate$ } from "../services/presentation-template-delete.service";
import { failPresentationTemplateImport$ } from "../services/presentation-template-failure.service";
import {
  deletePresentationTemplatePageKeys$,
  isPresentationTemplatePageKey,
  listPresentationTemplatePageKeys$,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  presentationTemplatePageFilename,
  presentationTemplatePageKey,
} from "../services/presentation-template-page.service";
import {
  lockPresentationTemplateLifecycle,
  publishPresentationTemplatePackage$,
} from "../services/presentation-template-package.service";
import type { RouteEntry } from "../route-entry";

const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

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

const templateRunAuth = {
  accept: ["zero", "sandbox"],
  acceptAnySandboxCapability: true,
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const presentationTemplatesDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Presentation templates are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const presentationTemplatesEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.PresentationTemplates, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

function templateNotFound(templateId: string) {
  return notFound(`Presentation template not found: ${templateId}`);
}

function activeImportError(row: PresentationTemplateRow) {
  return row.status === "pending" || row.status === "processing"
    ? null
    : conflict(`Presentation template import is already ${row.status}`);
}

function runIdFromAuth(auth: AuthContext): string | null {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : null;
}

async function loadTemplateForRun(
  db: ReadonlyDb,
  auth: AuthContext & { readonly orgId: string },
  templateId: string,
): Promise<PresentationTemplateRow | null> {
  const runId = runIdFromAuth(auth);
  return runId
    ? await loadRunOwnedPresentationTemplate(db, {
        orgId: auth.orgId,
        ownerUserId: auth.userId,
        runId,
        templateId,
      })
    : null;
}

const listInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
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
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const bodyResult = await get(createBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    createPresentationTemplate$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      body: bodyResult.data,
    },
    signal,
  );
});

const getParams$ = pathParamsOf(zeroPresentationTemplatesContract.get);
const getInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const params = get(getParams$);
  const row = await loadOwnedPresentationTemplate(get(db$), {
    orgId: auth.orgId,
    ownerUserId: auth.userId,
    templateId: params.templateId,
  });
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const visiblePageKeys =
    row.status === "processing" || row.status === "ready" ? row.pageKeys : [];
  return {
    status: 200 as const,
    body: {
      ...presentationTemplateSummary(row),
      pageUrls: visiblePageKeys.map(buildFileUrlFromKey),
    },
  };
});

const updateParams$ = pathParamsOf(zeroPresentationTemplatesContract.update);
const updateBody$ = bodyResultOf(zeroPresentationTemplatesContract.update);
const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
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
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
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
  const row = await loadTemplateForRun(get(db$), auth, params.templateId);
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
    const row = await loadTemplateForRun(get(db$), auth, params.templateId);
    signal.throwIfAborted();
    if (!row) {
      return templateNotFound(params.templateId);
    }
    const stateError = activeImportError(row);
    if (stateError) {
      return stateError;
    }

    const prefixedKeys = await set(
      listPresentationTemplatePageKeys$,
      row.id,
      signal,
    );
    const keys = Array.from({ length: bodyResult.data.count }, (_, index) => {
      return presentationTemplatePageKey(row.id, index);
    });
    const db = set(writeDb$);
    const prepared = await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, row.id);
      signal.throwIfAborted();
      const [active] = await tx
        .select({ pageKeys: presentationTemplates.pageKeys })
        .from(presentationTemplates)
        .where(
          and(
            eq(presentationTemplates.id, row.id),
            eq(presentationTemplates.orgId, auth.orgId),
            eq(presentationTemplates.ownerUserId, auth.userId),
            inArray(presentationTemplates.status, ["pending", "processing"]),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!active) {
        return false;
      }
      await set(
        deletePresentationTemplatePageKeys$,
        { keys: [...new Set([...active.pageKeys, ...prefixedKeys])] },
        signal,
      );
      const [updated] = await tx
        .update(presentationTemplates)
        .set({
          pageKeys: keys,
          aspectRatio: null,
          status: "pending",
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
      return updated !== undefined;
    });
    signal.throwIfAborted();
    if (!prepared) {
      return conflict("Presentation template is no longer importing");
    }

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const uploads = await Promise.all(
      keys.map(async (key, index) => {
        const metadata = artifactObjectMetadata(
          auth.userId,
          row.id,
          presentationTemplatePageFilename(index),
        );
        const uploadUrl = await get(
          generatePresignedPutUrl(
            bucket,
            key,
            PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
            PRESIGNED_URL_TTL_SECONDS,
            { usePublicEndpoint: true, metadata },
          ),
        );
        return {
          key,
          uploadUrl,
          uploadHeaders: s3MetadataHeaders(metadata),
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
  const row = await loadTemplateForRun(get(db$), auth, params.templateId);
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
  if (
    row.pageKeys.length > 0 &&
    (row.pageKeys.length !== keys.length ||
      row.pageKeys.some((key, index) => {
        return keys[index] !== key;
      }))
  ) {
    return badRequestMessage(
      "Page image keys do not match the prepared upload",
    );
  }

  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const validPages = await Promise.all(
    keys.map(async (key, index) => {
      if (!isPresentationTemplatePageKey(row.id, index, key)) {
        return false;
      }
      const head = await get(s3ObjectHead(bucket, key));
      if (
        head.kind === "missing" ||
        head.contentType !== PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE
      ) {
        return false;
      }
      const expected = artifactObjectMetadata(
        auth.userId,
        row.id,
        presentationTemplatePageFilename(index),
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
    return conflict("Presentation template is no longer importing");
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
  const row = await loadTemplateForRun(get(db$), auth, params.templateId);
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  if (row.status !== "processing" || row.pageKeys.length === 0) {
    return conflict(
      "Page images must be committed before publishing a package",
    );
  }
  const published = await set(
    publishPresentationTemplatePackage$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: row.id,
      files: bodyResult.data.files,
    },
    signal,
  );
  return published
    ? {
        status: 200 as const,
        body: { id: row.id, status: "ready" as const },
      }
    : conflict("Presentation template is no longer processing");
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
  const row = await loadTemplateForRun(get(db$), auth, params.templateId);
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const result = await set(
    failPresentationTemplateImport$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: row.id,
      error: bodyResult.data,
    },
    signal,
  );
  if (result.kind === "not-found") {
    return templateNotFound(params.templateId);
  }
  if (result.kind === "conflict") {
    return conflict(`Presentation template import is already ${result.status}`);
  }
  return {
    status: 200 as const,
    body: { id: result.id, status: "failed" as const },
  };
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
    handler: authRoute(templateRunAuth, sourceInner$),
  },
  {
    route: zeroPresentationTemplatesContract.preparePages,
    handler: authRoute(templateRunAuth, preparePagesInner$),
  },
  {
    route: zeroPresentationTemplatesContract.commitPages,
    handler: authRoute(templateRunAuth, commitPagesInner$),
  },
  {
    route: zeroPresentationTemplatesContract.publishPackage,
    handler: authRoute(templateRunAuth, packageInner$),
  },
  {
    route: zeroPresentationTemplatesContract.fail,
    handler: authRoute(templateRunAuth, failInner$),
  },
];
