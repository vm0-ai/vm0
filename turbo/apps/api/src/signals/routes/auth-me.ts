import { computed } from "ccstate";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import { userCache } from "@vm0/db/schema/user-cache";
import { eq } from "drizzle-orm";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { now } from "../external/time";
import type { RouteEntry } from "../route";

const USER_CACHE_TTL_MS = 15 * 60 * 1000;

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkEmailProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
}

function primaryEmail(user: ClerkEmailProfile): string | null {
  const email = user.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  });
  return email?.emailAddress ?? null;
}

function userEmail(userId: string) {
  return computed(async (get): Promise<string> => {
    const db = get(db$);
    const [cached] = await db
      .select({
        email: userCache.email,
        cachedAt: userCache.cachedAt,
      })
      .from(userCache)
      .where(eq(userCache.userId, userId))
      .limit(1);

    if (cached && now() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
      return cached.email;
    }

    const client = get(clerk$);
    const users = await client.users.getUserList({ userId: [userId] });
    const user = users.data.find((candidate: ClerkEmailProfile) => {
      return candidate.id === userId;
    });
    if (!user) {
      throw new Error(`No Clerk user found for user ${userId}`);
    }

    const email = primaryEmail(user);
    if (!email) {
      throw new Error(`No primary email found for user ${userId}`);
    }

    return email;
  });
}

const getAuthMeInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(authContext$);
  const email = await get(userEmail(auth.userId));

  return {
    status: 200 as const,
    body: {
      userId: auth.userId,
      email,
    },
  };
});

export const authMeRoutes: readonly RouteEntry[] = [
  {
    route: authContract.me,
    handler: authRoute({ acceptAnySandboxCapability: true }, getAuthMeInner$),
  },
];
