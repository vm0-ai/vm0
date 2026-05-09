import { auth } from "@clerk/nextjs/server";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { env } from "../../../src/env";
import { loadFeatureSwitchOverrides } from "../../../src/lib/zero/user/feature-switches-service";

export async function canViewDocsForUser(
  userId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<boolean> {
  if (!userId || !env().NEXT_PUBLIC_STRAPI_URL) {
    return false;
  }

  const overrides = await loadFeatureSwitchOverrides(
    orgId ?? undefined,
    userId,
  );

  return isFeatureEnabled(FeatureSwitchKey.DocsSite, {
    userId,
    orgId: orgId ?? undefined,
    overrides,
  });
}

export async function canViewDocs(): Promise<boolean> {
  const { userId, orgId } = await auth();
  return canViewDocsForUser(userId, orgId);
}
