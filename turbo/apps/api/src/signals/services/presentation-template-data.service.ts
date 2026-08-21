import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { PresentationTemplateSummary } from "@okouai/api-contracts/contracts/presentation-templates";
import { CANONICAL_WORKING_DIR } from "@okouai/api-contracts/contracts/runners";
import {
  parseUserPresentationTemplateId,
  userPresentationTemplateDirectory,
} from "@okouai/core/presentation-template-selection";
import { getPresentationTemplateStorageName } from "@okouai/core/storage-names";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export type PresentationTemplateRow = typeof presentationTemplates.$inferSelect;

export interface PresentationTemplateVolume {
  readonly name: string;
  readonly mountPath: string;
}

/**
 * Row ids for the private templates a message selected, in selection order.
 *
 * Deduplicated: one row is one package and one mount, so attaching the same
 * template twice must not ask the run to mount it at the same path twice.
 *
 * Syntax only. A well-formed id says nothing about whether that row exists or
 * whether the sender may read it; that is decided by
 * {@link authorizedUserPresentationTemplateIds}.
 */
export function selectedUserPresentationTemplateIds(
  generationTemplates: readonly GenerationTemplateRequest[],
): readonly string[] {
  const templateIds = new Set<string>();
  for (const template of generationTemplates) {
    if (template.type !== "presentation") {
      continue;
    }
    const rowId = parseUserPresentationTemplateId(
      template.selection.templateId,
    );
    if (rowId !== undefined) {
      templateIds.add(rowId);
    }
  }
  return [...templateIds];
}

/**
 * The subset of those ids this caller owns, in selection order.
 *
 * The row is the authority for its own existence and ownership. An id that
 * does not come back is indistinguishable from someone else's template and
 * from a deleted one on purpose, so a caller cannot use the answer to probe
 * which of the three it was.
 */
export async function authorizedUserPresentationTemplateIds(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly templateIds: readonly string[];
  },
): Promise<readonly string[]> {
  if (args.templateIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: presentationTemplates.id })
    .from(presentationTemplates)
    .where(
      and(
        inArray(presentationTemplates.id, [...args.templateIds]),
        eq(presentationTemplates.orgId, args.orgId),
        eq(presentationTemplates.ownerUserId, args.ownerUserId),
      ),
    );
  const owned = new Set(
    rows.map((row) => {
      return row.id;
    }),
  );
  return args.templateIds.filter((templateId) => {
    return owned.has(templateId);
  });
}

/**
 * The storage volumes that carry those templates' guidance packages.
 *
 * Mounted under the working directory rather than the skills root because the
 * skills root is chosen per framework inside run creation, while the prompt
 * naming this path is built before a framework exists.
 */
export function userPresentationTemplateVolumes(
  templateIds: readonly string[],
): readonly PresentationTemplateVolume[] {
  return templateIds.map((templateId) => {
    return {
      name: getPresentationTemplateStorageName(templateId),
      mountPath: `${CANONICAL_WORKING_DIR}/${userPresentationTemplateDirectory(templateId)}`,
    };
  });
}

/**
 * Shape the optional run-body field, so a run with no private template keeps
 * the compose-resolved volume list it would otherwise have had.
 */
export function additionalVolumesForRun(
  volumes: readonly PresentationTemplateVolume[],
): { additionalVolumes?: PresentationTemplateVolume[] } {
  return volumes.length === 0 ? {} : { additionalVolumes: [...volumes] };
}

export function presentationTemplateSummary(
  row: PresentationTemplateRow,
  coverUrl: string | null,
): PresentationTemplateSummary {
  return {
    id: row.id,
    title: row.title,
    sourceFilename: row.sourceFilename,
    coverUrl,
    pageCount: row.pageKeys.length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadOwnedPresentationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly templateId: string;
  },
): Promise<PresentationTemplateRow | null> {
  const [row] = await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.id, args.templateId),
        eq(presentationTemplates.orgId, args.orgId),
        eq(presentationTemplates.ownerUserId, args.ownerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listOwnedPresentationTemplates(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly ownerUserId: string },
): Promise<readonly PresentationTemplateRow[]> {
  return await db
    .select()
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.orgId, args.orgId),
        eq(presentationTemplates.ownerUserId, args.ownerUserId),
      ),
    )
    .orderBy(desc(presentationTemplates.createdAt));
}
