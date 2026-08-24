import { command, computed } from "ccstate";
import {
  presentationTemplatesContract,
  PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
} from "@okouai/api-contracts/contracts/presentation-templates";
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
import {
  publishPresentationTemplatesChangedForOrgSafely,
  publishPresentationTemplatesChangedForUserSafely,
} from "../external/realtime";
import { generatePresignedGetUrl } from "../external/s3";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  listAccessiblePresentationTemplates,
  loadAccessiblePresentationTemplate,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "../services/presentation-template-data.service";
import { deletePresentationTemplate$ } from "../services/presentation-template-delete.service";
import { publishPresentationTemplate$ } from "../services/presentation-template-publish.service";
import type { RouteEntry } from "../route-entry";

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

/** Publishing is done by the analysis run, not by the browser session. */
const templatePublishAuth = {
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
  return await Promise.all(
    row.pageKeys.map(async (key, index) => {
      return await sign(key, index);
    }),
  );
}

const publishBody$ = bodyResultOf(presentationTemplatesContract.publish);
const publishInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const bodyResult = await get(publishBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    publishPresentationTemplate$,
    { orgId: auth.orgId, ownerUserId: auth.userId, body: bodyResult.data },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "rejected") {
    return result.response;
  }
  const row = await loadAccessiblePresentationTemplate(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    templateId: result.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    throw new Error(`Published template not found: ${result.templateId}`);
  }
  const coverKey = row.pageKeys[0];
  const coverUrl = coverKey
    ? await get(
        generatePresignedGetUrl(
          env("R2_USER_ARTIFACTS_BUCKET_NAME"),
          coverKey,
          PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
          presentationTemplatePageFilename(0),
          true,
        ),
      )
    : null;
  await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: presentationTemplateSummary(row, coverUrl, auth.userId),
  };
});

const listInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const rows = await listAccessiblePresentationTemplates(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const summaries = await Promise.all(
    rows.map(async (row) => {
      const coverKey = row.pageKeys[0];
      const coverUrl = coverKey
        ? await get(
            generatePresignedGetUrl(
              bucket,
              coverKey,
              PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
              presentationTemplatePageFilename(0),
              true,
            ),
          )
        : null;
      return presentationTemplateSummary(row, coverUrl, auth.userId);
    }),
  );
  return { status: 200 as const, body: summaries };
});

const getParams$ = pathParamsOf(presentationTemplatesContract.get);
const getInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(presentationTemplatesEnabled$))) {
    return presentationTemplatesDisabled;
  }
  const params = get(getParams$);
  const row = await loadAccessiblePresentationTemplate(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
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
        PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
        presentationTemplatePageFilename(index),
        true,
      ),
    );
  });
  return {
    status: 200 as const,
    body: {
      ...presentationTemplateSummary(row, pageUrls[0] ?? null, auth.userId),
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
  const mutation = await set(writeDb$).transaction(async (tx) => {
    const whereOwner = and(
      eq(presentationTemplates.id, params.templateId),
      eq(presentationTemplates.orgId, auth.orgId),
      eq(presentationTemplates.ownerUserId, auth.userId),
    );
    const [previous] = await tx
      .select({ visibility: presentationTemplates.visibility })
      .from(presentationTemplates)
      .where(whereOwner)
      .for("update")
      .limit(1);
    if (!previous) {
      return null;
    }
    const [row] = await tx
      .update(presentationTemplates)
      .set({
        title: bodyResult.data.title,
        visibility: bodyResult.data.visibility,
        updatedAt: nowDate(),
        updatedBy: auth.userId,
      })
      .where(whereOwner)
      .returning();
    if (!row) {
      throw new Error(
        `Presentation template disappeared: ${params.templateId}`,
      );
    }
    return {
      row,
      workspaceVisible:
        previous.visibility === "public" || row.visibility === "public",
    };
  });
  signal.throwIfAborted();
  if (!mutation) {
    return templateNotFound(params.templateId);
  }
  const { row, workspaceVisible } = mutation;
  const coverKey = row.pageKeys[0];
  const coverUrl = coverKey
    ? await get(
        generatePresignedGetUrl(
          env("R2_USER_ARTIFACTS_BUCKET_NAME"),
          coverKey,
          PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
          presentationTemplatePageFilename(0),
          true,
        ),
      )
    : null;
  if (workspaceVisible) {
    await publishPresentationTemplatesChangedForOrgSafely(auth.orgId);
  } else {
    await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  }
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: presentationTemplateSummary(row, coverUrl, auth.userId),
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
  if (!deleted) {
    return templateNotFound(params.templateId);
  }
  if (deleted.visibility === "public") {
    await publishPresentationTemplatesChangedForOrgSafely(auth.orgId);
  } else {
    await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  }
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const presentationTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: presentationTemplatesContract.publish,
    handler: authRoute(templatePublishAuth, publishInner$),
  },
  {
    route: presentationTemplatesContract.list,
    handler: authRoute(templateReadAuth, listInner$),
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
