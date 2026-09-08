import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { EXPLAINER_VIDEO_TEMPLATE_ID } from "@okouai/core/explainer-video-template";
import { computed } from "ccstate";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userCache } from "@okouai/db/schema/user-cache";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { clerk$, type ClerkClient } from "../external/clerk";
import { db$, type ReadonlyDb } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export const introVideoDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Intro Video is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

export const introVideoEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const clerk = get(clerk$);
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  return await loadIntroVideoAccess(db, clerk, auth.userId, context);
});

async function loadIntroVideoAccess(
  db: Pick<ReadonlyDb, "select">,
  clerk: ClerkClient,
  userId: string,
  context: FeatureSwitchContext,
): Promise<boolean> {
  const enabled = isFeatureEnabled(FeatureSwitchKey.IntroVideo, context);
  if (
    enabled ||
    context.overrides?.[FeatureSwitchKey.IntroVideo] !== undefined
  ) {
    return enabled;
  }

  const [user] = await db
    .select({ email: userCache.email })
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);
  if (user?.email) {
    return isFeatureEnabled(FeatureSwitchKey.IntroVideo, {
      ...context,
      email: user.email,
    });
  }

  const users = await clerk.users.getUserList({
    userId: [userId],
    limit: 1,
  });
  const profile = users.data[0];
  const email =
    profile?.emailAddresses.find((candidate) => {
      return candidate.id === profile.primaryEmailAddressId;
    })?.emailAddress ?? profile?.emailAddresses[0]?.emailAddress;
  return isFeatureEnabled(FeatureSwitchKey.IntroVideo, {
    ...context,
    email,
  });
}

export async function loadIntroVideoTemplateAccess(
  db: Pick<ReadonlyDb, "select">,
  clerk: ClerkClient,
  userId: string,
  templates: readonly GenerationTemplateRequest[],
  context: FeatureSwitchContext,
): Promise<boolean> {
  if (
    !templates.some((template) => {
      return (
        template.type === "video" &&
        template.selection.stylePresetId === EXPLAINER_VIDEO_TEMPLATE_ID
      );
    })
  ) {
    return false;
  }
  return await loadIntroVideoAccess(db, clerk, userId, context);
}
