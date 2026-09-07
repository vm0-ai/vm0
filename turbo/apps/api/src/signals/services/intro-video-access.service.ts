import { computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userCache } from "@okouai/db/schema/user-cache";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { clerk$ } from "../external/clerk";
import { db$ } from "../external/db";
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
  if (isFeatureEnabled(FeatureSwitchKey.IntroVideo, context)) {
    return true;
  }

  const [user] = await db
    .select({ email: userCache.email })
    .from(userCache)
    .where(eq(userCache.userId, auth.userId))
    .limit(1);
  if (user?.email) {
    return isFeatureEnabled(FeatureSwitchKey.IntroVideo, {
      ...context,
      email: user.email,
    });
  }

  const users = await clerk.users.getUserList({
    userId: [auth.userId],
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
});
