import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { getPresentationTemplatePackageStorageName } from "@vm0/core/storage-names";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import {
  presentationTemplateRevisions,
  presentationTemplates,
} from "@vm0/db/schema/presentation-template";
import { and, eq, isNull } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { buildGenerationTemplatePrompt } from "../routes/generation-template-prompt";

export interface ResolvedGenerationTemplate {
  readonly prompt: string;
  readonly additionalVolumes:
    | {
        readonly name: string;
        readonly version: string;
        readonly mountPath: string;
      }[]
    | undefined;
}

export type GenerationTemplateResolution =
  | { readonly status: "resolved"; readonly value: ResolvedGenerationTemplate }
  | { readonly status: "invalid"; readonly message: string };

function isCustomPresentationTemplate(
  selection: GenerationTemplateRequest | null | undefined,
): selection is Extract<
  GenerationTemplateRequest,
  { readonly type: "presentation" }
> & {
  readonly selection: {
    readonly kind: "custom";
    readonly templateId: string;
    readonly templateRevisionId: string;
  };
} {
  return (
    selection?.type === "presentation" && selection.selection.kind === "custom"
  );
}

export async function resolveGenerationTemplate(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly selection: GenerationTemplateRequest | null | undefined;
  },
): Promise<GenerationTemplateResolution> {
  if (!args.selection) {
    return {
      status: "resolved",
      value: { prompt: "", additionalVolumes: undefined },
    };
  }
  if (!isCustomPresentationTemplate(args.selection)) {
    const built = buildGenerationTemplatePrompt(args.selection);
    return built.status === "resolved"
      ? {
          status: "resolved",
          value: { prompt: built.prompt, additionalVolumes: undefined },
        }
      : built;
  }

  const [row] = await db
    .select({
      templateId: presentationTemplates.id,
      ownerUserId: presentationTemplates.ownerUserId,
      accessScope: presentationTemplates.accessScope,
      revisionId: presentationTemplateRevisions.id,
      packageVersionId: presentationTemplateRevisions.packageStorageVersionId,
    })
    .from(presentationTemplates)
    .innerJoin(
      presentationTemplateRevisions,
      and(
        eq(
          presentationTemplateRevisions.id,
          args.selection.selection.templateRevisionId,
        ),
        eq(presentationTemplateRevisions.templateId, presentationTemplates.id),
      ),
    )
    .where(
      and(
        eq(presentationTemplates.id, args.selection.selection.templateId),
        eq(presentationTemplates.orgId, args.orgId),
        isNull(presentationTemplates.deletedAt),
        isNull(presentationTemplates.archivedAt),
      ),
    )
    .limit(1);
  if (!row) {
    return { status: "invalid", message: "Unknown presentation template" };
  }
  if (row.accessScope === "private" && row.ownerUserId !== args.userId) {
    const [membership] = await db
      .select({ role: orgMembersCache.role })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, args.orgId),
          eq(orgMembersCache.userId, args.userId),
        ),
      )
      .limit(1);
    if (membership?.role !== "admin") {
      return { status: "invalid", message: "Unknown presentation template" };
    }
  }

  const mountPath = "/mnt/presentation-template";
  return {
    status: "resolved",
    value: {
      prompt: [
        "# Artifact Template Context",
        "",
        "- The user deliberately selected this presentation template for this run. Treat it as the default visual language for any presentation you produce here.",
        "- It does not force you to generate a presentation; the user's prompt decides the task and output.",
        "",
        "Selected presentation template:",
        `- Template id: ${row.templateId}`,
        `- Revision id: ${row.revisionId}`,
        `- Package mount: ${mountPath}`,
        "",
        "When producing a presentation, read AGENT_RUNBOOK.md, template-manifest.json, and design-tokens.json from the mounted package before authoring slides. Follow its renderer guidance and packaged assets. Do not substitute a built-in presentation template.",
      ].join("\n"),
      additionalVolumes: [
        {
          name: getPresentationTemplatePackageStorageName(row.templateId),
          version: row.packageVersionId,
          mountPath,
        },
      ],
    },
  };
}
