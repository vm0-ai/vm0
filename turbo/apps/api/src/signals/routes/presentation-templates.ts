import { presentationTemplatesContract } from "@vm0/api-contracts/contracts/presentation-templates";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  presentationTemplateImports,
  presentationTemplateRevisions,
  presentationTemplates,
} from "@vm0/db/schema/presentation-template";
import { command } from "ccstate";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { nowDate } from "../external/time";
import {
  commitPresentationTemplateImport$,
  preparePresentationTemplateImport$,
  retryPresentationTemplateImport$,
} from "../services/presentation-template-import.service";
import {
  listPresentationTemplateImports,
  listPresentationTemplateRevisions,
  listVisiblePresentationTemplates,
  loadManageablePresentationTemplate,
  loadVisiblePresentationTemplate,
  presentationTemplateDto,
  presentationTemplateImportDto,
  updatePresentationTemplateMetadata,
  type PresentationTemplateMember,
} from "../services/presentation-template-data.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function member(auth: {
  readonly userId: string;
  readonly orgRole?: "admin" | "member";
}): PresentationTemplateMember {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function importAuth(auth: {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: "admin" | "member";
}) {
  return {
    userId: auth.userId,
    orgId: auth.orgId,
    orgRole: auth.orgRole ?? "member",
  } as const;
}

async function templatesEnabled(
  db: Parameters<typeof loadUserFeatureSwitchContext>[0],
  auth: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(
    FeatureSwitchKey.PresentationCustomTemplates,
    context,
  );
}

async function presentationTemplateNameExists(
  db: Db,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly accessScope: "private" | "organization";
    readonly excludeTemplateId?: string;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: presentationTemplates.id })
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.orgId, args.orgId),
        isNull(presentationTemplates.deletedAt),
        sql`lower(${presentationTemplates.name}) = lower(${args.name})`,
        eq(presentationTemplates.accessScope, args.accessScope),
        args.accessScope === "private"
          ? eq(presentationTemplates.ownerUserId, args.ownerUserId)
          : undefined,
        args.excludeTemplateId
          ? ne(presentationTemplates.id, args.excludeTemplateId)
          : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

const createBody$ = bodyResultOf(presentationTemplatesContract.create);
const createTemplate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  if (
    await presentationTemplateNameExists(db, {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      name: body.data.name,
      accessScope: "private",
    })
  ) {
    return conflict(
      "A private presentation template with this name already exists",
    );
  }
  signal.throwIfAborted();
  const timestamp = nowDate();
  const [row] = await db
    .insert(presentationTemplates)
    .values({
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      name: body.data.name,
      description: body.data.description ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  signal.throwIfAborted();
  if (!row) {
    throw new Error("Failed to create presentation template");
  }
  const template = await presentationTemplateDto(db, row, member(auth));
  signal.throwIfAborted();
  return {
    status: 201 as const,
    body: template,
  };
});

const listQuery$ = queryOf(presentationTemplatesContract.list);
const listTemplates$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = await get(listQuery$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return { status: 200 as const, body: { templates: [] } };
  }
  signal.throwIfAborted();
  const templates = await listVisiblePresentationTemplates(db, {
    orgId: auth.orgId,
    member: member(auth),
    includeArchived: query.includeArchived ?? false,
  });
  signal.throwIfAborted();
  return { status: 200 as const, body: { templates: [...templates] } };
});

const getParams$ = pathParamsOf(presentationTemplatesContract.get);
const getTemplate$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(getParams$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const row = await loadVisiblePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!row) {
    return notFound("Presentation template not found");
  }
  const template = await presentationTemplateDto(db, row, member(auth));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: template,
  };
});

const updateParams$ = pathParamsOf(presentationTemplatesContract.update);
const updateBody$ = bodyResultOf(presentationTemplatesContract.update);
const updateTemplate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const [params, body] = await Promise.all([
    get(updateParams$),
    get(updateBody$),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const current = await loadManageablePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!current) {
    return notFound("Presentation template not found");
  }
  const nextName = body.data.name ?? current.name;
  const nextScope = body.data.accessScope ?? current.accessScope;
  if (
    await presentationTemplateNameExists(db, {
      orgId: auth.orgId,
      ownerUserId: current.ownerUserId,
      name: nextName,
      accessScope: nextScope,
      excludeTemplateId: current.id,
    })
  ) {
    return conflict(
      "A presentation template with this name already exists in that access scope",
    );
  }
  signal.throwIfAborted();
  const row = await updatePresentationTemplateMetadata(db, {
    templateId: current.id,
    userId: auth.userId,
    ...body.data,
  });
  signal.throwIfAborted();
  const template = await presentationTemplateDto(db, row, member(auth));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: template,
  };
});

const prepareParams$ = pathParamsOf(
  presentationTemplatesContract.prepareImport,
);
const prepareBody$ = bodyResultOf(presentationTemplatesContract.prepareImport);
const prepareImport$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const [params, body] = await Promise.all([
    get(prepareParams$),
    get(prepareBody$),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    preparePresentationTemplateImport$,
    {
      auth: importAuth(auth),
      templateId: params.id,
      filename: body.data.filename,
      contentType: body.data.contentType,
      size: body.data.size,
    },
    signal,
  );
  if ("body" in result) {
    return result;
  }
  signal.throwIfAborted();
  const db = get(db$);
  const importDto = await presentationTemplateImportDto(db, result.import);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      import: importDto,
      uploadUrl: result.uploadUrl,
    },
  };
});

const commitParams$ = pathParamsOf(presentationTemplatesContract.commitImport);
const commitImport$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(commitParams$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const result = await set(
    commitPresentationTemplateImport$,
    {
      auth: importAuth(auth),
      templateId: params.id,
      importId: params.importId,
    },
    signal,
  );
  if (result.status !== 202) {
    return result;
  }
  signal.throwIfAborted();
  const [row] = await db
    .select()
    .from(presentationTemplateImports)
    .where(eq(presentationTemplateImports.id, params.importId))
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    return notFound("Presentation template import not found");
  }
  const importDto = await presentationTemplateImportDto(db, row);
  signal.throwIfAborted();
  return {
    status: 202 as const,
    body: importDto,
  };
});

const importsParams$ = pathParamsOf(presentationTemplatesContract.listImports);
const listImports$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(importsParams$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const template = await loadManageablePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!template) {
    return notFound("Presentation template not found");
  }
  const imports = await listPresentationTemplateImports(db, template.id);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      imports,
    },
  };
});

const retryParams$ = pathParamsOf(presentationTemplatesContract.retryImport);
const retryImport$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(retryParams$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const result = await set(
    retryPresentationTemplateImport$,
    {
      auth: importAuth(auth),
      templateId: params.id,
      importId: params.importId,
    },
    signal,
  );
  if (result.status !== 202) {
    return result;
  }
  signal.throwIfAborted();
  const [row] = await db
    .select()
    .from(presentationTemplateImports)
    .where(eq(presentationTemplateImports.id, params.importId))
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    return notFound("Presentation template import not found");
  }
  const importDto = await presentationTemplateImportDto(db, row);
  signal.throwIfAborted();
  return {
    status: 202 as const,
    body: importDto,
  };
});

const revisionsParams$ = pathParamsOf(
  presentationTemplatesContract.listRevisions,
);
const listRevisions$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(revisionsParams$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const template = await loadManageablePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!template) {
    return notFound("Presentation template not found");
  }
  const revisions = await listPresentationTemplateRevisions(db, template.id);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      revisions,
    },
  };
});

const activateParams$ = pathParamsOf(
  presentationTemplatesContract.activateRevision,
);
const activateRevision$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(activateParams$);
  signal.throwIfAborted();
  const db = set(writeDb$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const template = await loadManageablePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!template) {
    return notFound("Presentation template not found");
  }
  const [revision] = await db
    .select({ id: presentationTemplateRevisions.id })
    .from(presentationTemplateRevisions)
    .where(
      and(
        eq(presentationTemplateRevisions.id, params.revisionId),
        eq(presentationTemplateRevisions.templateId, template.id),
        eq(presentationTemplateRevisions.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!revision) {
    return notFound("Presentation template revision not found");
  }
  const timestamp = nowDate();
  const [row] = await db
    .update(presentationTemplates)
    .set({
      activeRevisionId: revision.id,
      updatedAt: timestamp,
      updatedBy: auth.userId,
    })
    .where(eq(presentationTemplates.id, template.id))
    .returning();
  signal.throwIfAborted();
  if (!row) {
    throw new Error("Presentation template disappeared during activation");
  }
  const result = await presentationTemplateDto(db, row, member(auth));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: result,
  };
});

const previewParams$ = pathParamsOf(presentationTemplatesContract.preview);
const getPreview$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(previewParams$);
  signal.throwIfAborted();
  const db = get(db$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const template = await loadVisiblePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!template) {
    return notFound("Presentation template not found");
  }
  const [revision] = await db
    .select({
      previewS3Prefix: presentationTemplateRevisions.previewS3Prefix,
      manifest: presentationTemplateRevisions.manifest,
    })
    .from(presentationTemplateRevisions)
    .where(
      and(
        eq(presentationTemplateRevisions.id, params.revisionId),
        eq(presentationTemplateRevisions.templateId, template.id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!revision) {
    return notFound("Presentation template revision not found");
  }
  if (params.index >= revision.manifest.slideCount) {
    return notFound("Presentation template preview not found");
  }
  const url = await get(
    generatePresignedGetUrl(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      `${revision.previewS3Prefix}/${params.index}.png`,
      15 * 60,
    ),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { url } };
});

const archiveParams$ = pathParamsOf(presentationTemplatesContract.archive);
const archiveBody$ = bodyResultOf(presentationTemplatesContract.archive);
const archiveTemplate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const [params, body] = await Promise.all([
    get(archiveParams$),
    get(archiveBody$),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const template = await loadManageablePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!template) {
    return notFound("Presentation template not found");
  }
  const row = await updatePresentationTemplateMetadata(db, {
    templateId: template.id,
    userId: auth.userId,
    archivedAt: body.data.archived ? nowDate() : null,
  });
  signal.throwIfAborted();
  const result = await presentationTemplateDto(db, row, member(auth));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: result,
  };
});

const deleteParams$ = pathParamsOf(presentationTemplatesContract.delete);
const deleteTemplate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = await get(deleteParams$);
  signal.throwIfAborted();
  const db = set(writeDb$);
  if (!(await templatesEnabled(db, auth))) {
    return notFound("Presentation templates are not enabled");
  }
  signal.throwIfAborted();
  const template = await loadManageablePresentationTemplate(db, {
    orgId: auth.orgId,
    templateId: params.id,
    member: member(auth),
  });
  signal.throwIfAborted();
  if (!template) {
    return notFound("Presentation template not found");
  }
  const timestamp = nowDate();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${template.id}))`,
    );
    await tx
      .update(presentationTemplates)
      .set({
        deletedAt: timestamp,
        updatedAt: timestamp,
        updatedBy: auth.userId,
      })
      .where(eq(presentationTemplates.id, template.id));
    await tx
      .update(presentationTemplateImports)
      .set({
        status: "failed",
        errorCode: "template_deleted",
        errorMessage: "Template was deleted before analysis completed",
        completedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(presentationTemplateImports.templateId, template.id),
          inArray(presentationTemplateImports.status, [
            "uploading",
            "queued",
            "processing",
          ]),
        ),
      );
  });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const presentationTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: presentationTemplatesContract.create,
    handler: authRoute(writeAuth, createTemplate$),
  },
  {
    route: presentationTemplatesContract.list,
    handler: authRoute(readAuth, listTemplates$),
  },
  {
    route: presentationTemplatesContract.get,
    handler: authRoute(readAuth, getTemplate$),
  },
  {
    route: presentationTemplatesContract.update,
    handler: authRoute(writeAuth, updateTemplate$),
  },
  {
    route: presentationTemplatesContract.prepareImport,
    handler: authRoute(writeAuth, prepareImport$),
  },
  {
    route: presentationTemplatesContract.commitImport,
    handler: authRoute(writeAuth, commitImport$),
  },
  {
    route: presentationTemplatesContract.listImports,
    handler: authRoute(readAuth, listImports$),
  },
  {
    route: presentationTemplatesContract.retryImport,
    handler: authRoute(writeAuth, retryImport$),
  },
  {
    route: presentationTemplatesContract.listRevisions,
    handler: authRoute(readAuth, listRevisions$),
  },
  {
    route: presentationTemplatesContract.activateRevision,
    handler: authRoute(writeAuth, activateRevision$),
  },
  {
    route: presentationTemplatesContract.preview,
    handler: authRoute(readAuth, getPreview$),
  },
  {
    route: presentationTemplatesContract.archive,
    handler: authRoute(writeAuth, archiveTemplate$),
  },
  {
    route: presentationTemplatesContract.delete,
    handler: authRoute(writeAuth, deleteTemplate$),
  },
];
