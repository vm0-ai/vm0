import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { loadFeatureSwitchOverrides } from "../../../src/lib/zero/user/feature-switches-service";

type FeatureSwitchOverridesLoader = (
  orgId: string | undefined,
  userId: string | undefined,
) => Promise<Partial<Record<FeatureSwitchKey, boolean>> | undefined>;

function evaluateDocsSiteStatic(
  userId: string | null | undefined,
  orgId: string | null | undefined,
): boolean {
  return isFeatureEnabled(FeatureSwitchKey.DocsSite, {
    userId: userId ?? undefined,
    orgId: orgId ?? undefined,
  });
}

export function createCanViewDocsForUser(
  loadFeatureSwitchOverridesForUser: FeatureSwitchOverridesLoader,
) {
  return cache(
    async (
      userId: string | null | undefined,
      orgId: string | null | undefined,
    ): Promise<boolean> => {
      if (!userId || !orgId) {
        return evaluateDocsSiteStatic(userId, orgId);
      }

      try {
        const overrides = await loadFeatureSwitchOverridesForUser(
          orgId,
          userId,
        );
        return isFeatureEnabled(FeatureSwitchKey.DocsSite, {
          userId,
          orgId,
          overrides,
        });
      } catch {
        return evaluateDocsSiteStatic(userId, orgId);
      }
    },
  );
}

export const canViewDocsForUser = createCanViewDocsForUser(
  loadFeatureSwitchOverrides,
);

export async function canViewDocs(): Promise<boolean> {
  const { userId, orgId } = await auth();
  return canViewDocsForUser(userId, orgId);
}
