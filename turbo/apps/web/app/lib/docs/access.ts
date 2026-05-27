import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

export const canViewDocsForUser = cache(
  async (
    userId: string | null | undefined,
    orgId: string | null | undefined,
  ): Promise<boolean> => {
    return isFeatureEnabled(FeatureSwitchKey.DocsSite, {
      userId: userId ?? undefined,
      orgId: orgId ?? undefined,
    });
  },
);

export async function canViewDocs(): Promise<boolean> {
  const { userId, orgId } = await auth();
  return canViewDocsForUser(userId, orgId);
}
