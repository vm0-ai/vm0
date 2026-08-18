import { command, computed } from "ccstate";
import { zeroPresentationTemplatesContract } from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  listOwnedPresentationTemplates,
  loadOwnedPresentationTemplate,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "../services/presentation-template-data.service";
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

export const zeroPresentationTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: zeroPresentationTemplatesContract.list,
    handler: authRoute(templateReadAuth, listInner$),
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
];
