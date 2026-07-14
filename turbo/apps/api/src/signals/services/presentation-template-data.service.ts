import type { PresentationTemplate } from "@vm0/api-contracts/contracts/presentation-templates";
import {
  presentationTemplateImports,
  presentationTemplateRevisions,
  presentationTemplates,
  type PresentationTemplateAccessScope,
} from "@vm0/db/schema/presentation-template";
import { and, desc, eq, isNull, or } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";

export interface PresentationTemplateMember {
  readonly userId: string;
  readonly role: "admin" | "member";
}

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

function canManageTemplate(
  template: Pick<PresentationTemplateRow, "ownerUserId">,
  member: PresentationTemplateMember,
): boolean {
  return template.ownerUserId === member.userId || member.role === "admin";
}

function canReadTemplate(
  template: Pick<
    PresentationTemplateRow,
    "accessScope" | "ownerUserId" | "deletedAt"
  >,
  member: PresentationTemplateMember,
): boolean {
  return (
    template.deletedAt === null &&
    (template.accessScope === "organization" ||
      canManageTemplate(template, member))
  );
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export async function presentationTemplateImportDto(
  db: ReadonlyDb,
  row: typeof presentationTemplateImports.$inferSelect,
) {
  const [revision] = await db
    .select({ id: presentationTemplateRevisions.id })
    .from(presentationTemplateRevisions)
    .where(eq(presentationTemplateRevisions.sourceImportId, row.id))
    .limit(1);

  return {
    id: row.id,
    status: row.status,
    sourceFilename: row.sourceFilename,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    canRetry: row.status === "failed" && row.sourceStorageVersionId !== null,
    resultRevisionId: revision?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    uploadCommittedAt: iso(row.uploadCommittedAt),
    processingStartedAt: iso(row.processingStartedAt),
    completedAt: iso(row.completedAt),
  };
}

function revisionDto(row: typeof presentationTemplateRevisions.$inferSelect) {
  return {
    id: row.id,
    revisionNumber: row.revisionNumber,
    compilerVersion: row.compilerVersion,
    slideCount: row.manifest.slideCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function presentationTemplateDto(
  db: ReadonlyDb,
  row: PresentationTemplateRow,
  member: PresentationTemplateMember,
): Promise<PresentationTemplate> {
  const canManage = canManageTemplate(row, member);
  const [activeRevisionRows, latestImportRows] = await Promise.all([
    row.activeRevisionId
      ? db
          .select()
          .from(presentationTemplateRevisions)
          .where(eq(presentationTemplateRevisions.id, row.activeRevisionId))
          .limit(1)
      : Promise.resolve([]),
    canManage
      ? db
          .select()
          .from(presentationTemplateImports)
          .where(eq(presentationTemplateImports.templateId, row.id))
          .orderBy(desc(presentationTemplateImports.createdAt))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const activeRevision = activeRevisionRows[0] ?? null;
  const latestImport = latestImportRows[0] ?? null;

  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    description: row.description,
    accessScope: row.accessScope,
    activeRevision: activeRevision ? revisionDto(activeRevision) : null,
    latestImport: latestImport
      ? await presentationTemplateImportDto(db, latestImport)
      : null,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canManage,
  };
}

export async function listVisiblePresentationTemplates(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: PresentationTemplateMember;
    readonly includeArchived: boolean;
  },
): Promise<readonly PresentationTemplate[]> {
  const rows = await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.orgId, args.orgId),
        isNull(presentationTemplates.deletedAt),
        args.includeArchived
          ? args.member.role === "admin"
            ? undefined
            : or(
                isNull(presentationTemplates.archivedAt),
                eq(presentationTemplates.ownerUserId, args.member.userId),
              )
          : isNull(presentationTemplates.archivedAt),
        args.member.role === "admin"
          ? undefined
          : or(
              eq(presentationTemplates.accessScope, "organization"),
              eq(presentationTemplates.ownerUserId, args.member.userId),
            ),
      ),
    )
    .orderBy(desc(presentationTemplates.updatedAt));

  return await Promise.all(
    rows.map(async (row) => {
      return await presentationTemplateDto(db, row, args.member);
    }),
  );
}

export async function loadVisiblePresentationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly templateId: string;
    readonly member: PresentationTemplateMember;
  },
): Promise<PresentationTemplateRow | null> {
  const [row] = await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.id, args.templateId),
        eq(presentationTemplates.orgId, args.orgId),
      ),
    )
    .limit(1);

  return row && canReadTemplate(row, args.member) ? row : null;
}

export async function loadManageablePresentationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly templateId: string;
    readonly member: PresentationTemplateMember;
  },
): Promise<PresentationTemplateRow | null> {
  const row = await loadVisiblePresentationTemplate(db, args);
  return row && canManageTemplate(row, args.member) ? row : null;
}

export async function listPresentationTemplateImports(
  db: ReadonlyDb,
  templateId: string,
) {
  const rows = await db
    .select()
    .from(presentationTemplateImports)
    .where(eq(presentationTemplateImports.templateId, templateId))
    .orderBy(desc(presentationTemplateImports.createdAt));
  return await Promise.all(
    rows.map(async (row) => {
      return await presentationTemplateImportDto(db, row);
    }),
  );
}

export async function listPresentationTemplateRevisions(
  db: ReadonlyDb,
  templateId: string,
) {
  const rows = await db
    .select()
    .from(presentationTemplateRevisions)
    .where(eq(presentationTemplateRevisions.templateId, templateId))
    .orderBy(desc(presentationTemplateRevisions.revisionNumber));
  return rows.map(revisionDto);
}

export async function updatePresentationTemplateMetadata(
  db: Db,
  args: {
    readonly templateId: string;
    readonly userId: string;
    readonly name?: string;
    readonly description?: string | null;
    readonly accessScope?: PresentationTemplateAccessScope;
    readonly archivedAt?: Date | null;
  },
): Promise<PresentationTemplateRow> {
  const [row] = await db
    .update(presentationTemplates)
    .set({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
      ...(args.accessScope !== undefined
        ? { accessScope: args.accessScope }
        : {}),
      ...(args.archivedAt !== undefined ? { archivedAt: args.archivedAt } : {}),
      updatedBy: args.userId,
      updatedAt: nowDate(),
    })
    .where(eq(presentationTemplates.id, args.templateId))
    .returning();
  if (!row) {
    throw new Error("Presentation template disappeared during update");
  }
  return row;
}
