import { command, computed } from "ccstate";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  presentationTemplatesContract,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq } from "drizzle-orm";

import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  commitPresentationTemplateImport$,
  createPresentationTemplateImport$,
  requestPresentationTemplateUpload$,
} from "../services/presentation-template-import.service";
import {
  listOwnedPresentationTemplates,
  loadOwnedPresentationTemplate,
  loadRunOwnedPresentationTemplate,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "../services/presentation-template-data.service";
import { failPresentationTemplateImport$ } from "../services/presentation-template-failure.service";
import { deletePresentationTemplate$ } from "../services/presentation-template-delete.service";
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

/** The analysis run reaches its own import through a run-scoped token. */
const templateRunReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "presentation-template:read",
} as const;

const templateRunWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "presentation-template:write",
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

function presentationTemplatePageFilename(index: number): string {
  return `page-${(index + 1).toString().padStart(3, "0")}.png`;
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
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
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

const createImportBody$ = bodyResultOf(
  presentationTemplatesContract.createImport,
);
const createImportInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await get(presentationTemplatesEnabled$))) {
      return presentationTemplatesDisabled;
    }
    const bodyResult = await get(createImportBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      createPresentationTemplateImport$,
      {
        orgId: auth.orgId,
        ownerUserId: auth.userId,
        body: bodyResult.data,
      },
      signal,
    );
  },
);

const requestUploadParams$ = pathParamsOf(
  presentationTemplatesContract.requestUpload,
);
const requestUploadBody$ = bodyResultOf(
  presentationTemplatesContract.requestUpload,
);
const requestUploadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await get(presentationTemplatesEnabled$))) {
      return presentationTemplatesDisabled;
    }
    const bodyResult = await get(requestUploadBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      requestPresentationTemplateUpload$,
      {
        orgId: auth.orgId,
        ownerUserId: auth.userId,
        templateId: get(requestUploadParams$).templateId,
        body: bodyResult.data,
      },
      signal,
    );
  },
);

const commitParams$ = pathParamsOf(presentationTemplatesContract.commit);
const commitInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  return await set(
    commitPresentationTemplateImport$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: get(commitParams$).templateId,
    },
    signal,
  );
});

/** Run-scoped reads resolve the caller's own run, never a caller-named one. */
function runAuthContext(auth: {
  readonly orgId: string;
  readonly userId: string;
}): {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
} | null {
  return "runId" in auth && typeof auth.runId === "string"
    ? { orgId: auth.orgId, userId: auth.userId, runId: auth.runId }
    : null;
}

const sourceParams$ = pathParamsOf(presentationTemplatesContract.source);
const sourceInner$ = computed(async (get) => {
  const auth = runAuthContext(get(organizationAuthContext$));
  const params = get(sourceParams$);
  const row = auth
    ? await loadRunOwnedPresentationTemplate(get(db$), auth, params.templateId)
    : null;
  if (!row?.sourceStorageKey) {
    return templateNotFound(params.templateId);
  }
  return {
    status: 200 as const,
    body: {
      url: await get(
        generatePresignedGetUrl(
          env("R2_USER_ARTIFACTS_BUCKET_NAME"),
          row.sourceStorageKey,
          PRESIGNED_URL_TTL_SECONDS,
          row.sourceFilename,
          true,
        ),
      ),
      filename: row.sourceFilename,
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
    },
  };
});

const pagesParams$ = pathParamsOf(presentationTemplatesContract.pages);
const pagesInner$ = computed(async (get) => {
  const auth = runAuthContext(get(organizationAuthContext$));
  const params = get(pagesParams$);
  const row = auth
    ? await loadRunOwnedPresentationTemplate(get(db$), auth, params.templateId)
    : null;
  if (!row || row.pageKeys.length === 0) {
    return templateNotFound(params.templateId);
  }
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const pages = await Promise.all(
    row.pageKeys.map(async (key, index) => {
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
      };
    }),
  );
  return { status: 200 as const, body: { pages } };
});

const failParams$ = pathParamsOf(presentationTemplatesContract.fail);
const failBody$ = bodyResultOf(presentationTemplatesContract.fail);
const failInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = runAuthContext(get(organizationAuthContext$));
  const params = get(failParams$);
  const bodyResult = await get(failBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const row = auth
    ? await loadRunOwnedPresentationTemplate(get(db$), auth, params.templateId)
    : null;
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const result = await set(
    failPresentationTemplateImport$,
    {
      orgId: row.orgId,
      ownerUserId: row.ownerUserId,
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

const getParams$ = pathParamsOf(presentationTemplatesContract.get);
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
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
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

const updateParams$ = pathParamsOf(presentationTemplatesContract.update);
const updateBody$ = bodyResultOf(presentationTemplatesContract.update);
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
            env("R2_USER_ARTIFACTS_BUCKET_NAME"),
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

const deleteParams$ = pathParamsOf(presentationTemplatesContract.delete);
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

export const presentationTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: presentationTemplatesContract.list,
    handler: authRoute(templateReadAuth, listInner$),
  },
  {
    route: presentationTemplatesContract.createImport,
    handler: authRoute(templateWriteAuth, createImportInner$),
  },
  {
    route: presentationTemplatesContract.requestUpload,
    handler: authRoute(templateWriteAuth, requestUploadInner$),
  },
  {
    route: presentationTemplatesContract.commit,
    handler: authRoute(templateWriteAuth, commitInner$),
  },
  {
    route: presentationTemplatesContract.source,
    handler: authRoute(templateRunReadAuth, sourceInner$),
  },
  {
    route: presentationTemplatesContract.pages,
    handler: authRoute(templateRunReadAuth, pagesInner$),
  },
  {
    route: presentationTemplatesContract.fail,
    handler: authRoute(templateRunWriteAuth, failInner$),
  },
  {
    route: presentationTemplatesContract.get,
    handler: authRoute(templateReadAuth, getInner$),
  },
  {
    route: presentationTemplatesContract.update,
    handler: authRoute(templateWriteAuth, updateInner$),
  },
  {
    route: presentationTemplatesContract.delete,
    handler: authRoute(templateWriteAuth, deleteInner$),
  },
];
