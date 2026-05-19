import { command } from "ccstate";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import { userCache } from "@vm0/db/schema/user-cache";
import { eq } from "drizzle-orm";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
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
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly primaryEmailAddressId: string | null;
}

function primaryEmail(user: ClerkEmailProfile): string | null {
  const email = user.emailAddresses.find((candidate) => {
    return candidate.id === user.primaryEmailAddressId;
  });
  return email?.emailAddress ?? null;
}

function fullName(user: ClerkEmailProfile): string | null {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

const getAuthMeInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(authContext$);
    const db = get(db$);
    const [cached] = await db
      .select({
        email: userCache.email,
        cachedAt: userCache.cachedAt,
      })
      .from(userCache)
      .where(eq(userCache.userId, auth.userId))
      .limit(1);
    signal.throwIfAborted();

    const currentTime = now();
    if (cached && currentTime - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
      return {
        status: 200 as const,
        body: {
          userId: auth.userId,
          email: cached.email,
        },
      };
    }

    const client = get(clerk$);
    const users = await client.users.getUserList({ userId: [auth.userId] });
    signal.throwIfAborted();
    const user = users.data.find((candidate: ClerkEmailProfile) => {
      return candidate.id === auth.userId;
    });
    if (!user) {
      throw new Error(`No Clerk user found for user ${auth.userId}`);
    }

    const email = primaryEmail(user);
    if (!email) {
      throw new Error(`No primary email found for user ${auth.userId}`);
    }

    const refreshedAt = new Date(now());
    const name = fullName(user);
    const writeDb = set(writeDb$);
    await writeDb
      .insert(userCache)
      .values({ userId: auth.userId, email, name, cachedAt: refreshedAt })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: { email, name, cachedAt: refreshedAt },
      });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        userId: auth.userId,
        email,
      },
    };
  },
);

export const authMeRoutes: readonly RouteEntry[] = [
  {
    route: authContract.me,
    handler: authRoute({ acceptAnySandboxCapability: true }, getAuthMeInner$),
  },
];
