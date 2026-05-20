import { and, eq } from "drizzle-orm";
import {
  isSupportedRunModel,
  normalizeRunModelId,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";

export async function getUserModelPreferenceModel(
  orgId: string,
  userId: string,
): Promise<SupportedRunModel | null> {
  const [row] = await globalThis.services.db
    .select({
      model: orgMembersMetadata.selectedModel,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  if (!row?.model) {
    return null;
  }

  const canonical = normalizeRunModelId(row.model);
  return isSupportedRunModel(canonical) ? canonical : null;
}
