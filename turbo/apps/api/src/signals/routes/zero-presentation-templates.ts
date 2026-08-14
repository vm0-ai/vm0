import { command, computed } from "ccstate";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  zeroPresentationTemplatesContract,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq } from "drizzle-orm";

import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { generatePresignedGetUrl, s3ObjectHead } from "../external/s3";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { commitPresentationTemplate$ } from "../services/presentation-template-commit.service";
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
  presentationTemplatePageFilename,
  presentationTemplatePageMetadata,
} from "../services/presentation-template-object.service";
import { publishPresentationTemplatePackage$ } from "../services/presentation-template-package.service";
import { preparePresentationTemplate$ } from "../services/presentation-template-prepare.service";
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

async function signedPageUrls(
  row: PresentationTemplateRow,
  sign: (key: string, index: number) => Promise<string>,
): Promise<readonly string[]> {
  if (row.status !== "processing" && row.status !== "ready") {
    return [];
  }
  return await Promise.all(
    row.pageKeys.map(async (key, index) => {
      return await sign(key, index);
    }),
  );
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
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const summaries = await Promise.all(
    rows.map(async (row) => {
      const coverKey = row.pageKeys[0];
      const coverUrl =
        coverKey && (row.status === "processing" || row.status === "ready")
          ? await get(
              generatePresignedGetUrl(
                bucket,
                coverKey,
                PRESIGNED_URL_TTL_SECONDS,
                presentationTemplatePageFilename(0),
                true,
              ),
            )
          : null;
      return presentationTemplateSummary(row, coverUrl);
    }),
  );
  return { status: 200 as const, body: summaries };
});

const prepareBody$ = bodyResultOf(zeroPresentationTemplatesContract.prepare);
const prepareInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const bodyResult = await get(prepareBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    preparePresentationTemplate$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      body: bodyResult.data,
    },
    signal,
  );
});

const commitParams$ = pathParamsOf(zeroPresentationTemplatesContract.commit);
const commitInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const params = get(commitParams$);
  return await set(
    commitPresentationTemplate$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: params.templateId,
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
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const pageUrls = await signedPageUrls(row, async (key, index) => {
    return await get(
      generatePresignedGetUrl(
        bucket,
        key,
        PRESIGNED_URL_TTL_SECONDS,
        presentationTemplatePageFilename(index),
        true,
      ),
    );
  });
  return {
    status: 200 as const,
    body: {
      ...presentationTemplateSummary(row, pageUrls[0] ?? null),
      pageUrls,
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
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const coverKey = row.pageKeys[0];
  const coverUrl =
    coverKey && (row.status === "processing" || row.status === "ready")
      ? await get(
          generatePresignedGetUrl(
            env("R2_USER_STORAGES_BUCKET_NAME"),
            coverKey,
            PRESIGNED_URL_TTL_SECONDS,
            presentationTemplatePageFilename(0),
            true,
          ),
        )
      : null;
  return {
    status: 200 as const,
    body: presentationTemplateSummary(row, coverUrl),
  };
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
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const head = await get(s3ObjectHead(bucket, row.sourceStorageKey));
  if (
    head.kind === "missing" ||
    head.contentLength !== row.sourceSizeBytes ||
    head.contentType !== PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE
  ) {
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
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
      size: row.sourceSizeBytes,
    },
  };
});

const pagesParams$ = pathParamsOf(zeroPresentationTemplatesContract.pages);
const pagesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pagesParams$);
  const row = await loadTemplateForRun(get(db$), auth, params.templateId);
  if (!row || row.pageKeys.length === 0) {
    return templateNotFound(params.templateId);
  }
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const pages = await Promise.all(
    row.pageKeys.map(async (key, index) => {
      const size = row.pageSizesBytes[index];
      if (size === undefined) {
        return null;
      }
      const head = await get(s3ObjectHead(bucket, key));
      if (
        head.kind === "missing" ||
        head.contentLength !== size ||
        head.contentType !== PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE ||
        !Object.entries(
          presentationTemplatePageMetadata({
            templateId: row.id,
            ownerUserId: row.ownerUserId,
            index,
            size,
          }),
        ).every(([name, value]) => {
          return head.metadata[name] === value;
        })
      ) {
        return null;
      }
      const filename = presentationTemplatePageFilename(index);
      return {
        index,
        filename,
        url: await get(
          generatePresignedGetUrl(
            bucket,
            key,
            PRESIGNED_URL_TTL_SECONDS,
            filename,
            true,
          ),
        ),
        contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
        size,
      };
    }),
  );
  if (
    pages.some((page) => {
      return page === null;
    })
  ) {
    return notFound("One or more presentation template pages were not found");
  }
  return {
    status: 200 as const,
    body: {
      pages: pages.filter((page) => {
        return page !== null;
      }),
    },
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
      "The complete source and page set must be committed before publishing a package",
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
    route: zeroPresentationTemplatesContract.prepare,
    handler: authRoute(templateWriteAuth, prepareInner$),
  },
  {
    route: zeroPresentationTemplatesContract.commit,
    handler: authRoute(templateWriteAuth, commitInner$),
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
    route: zeroPresentationTemplatesContract.pages,
    handler: authRoute(templateRunAuth, pagesInner$),
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
