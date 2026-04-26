import type { SessionAuthObject } from "@clerk/backend";
import { computed, type Computed } from "ccstate";

import { request$ } from "../context/hono";
import { clerk$ } from "../external/clerk";

type SignedInSessionAuthObject = Extract<
  SessionAuthObject,
  { isAuthenticated: true }
>;

export type ApiOrgRole = "admin" | "member";

type ClerkSessionAuthContext =
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
    };

function mapClerkOrgRole(
  orgRole: SignedInSessionAuthObject["orgRole"],
): ApiOrgRole | undefined {
  if (!orgRole) {
    return undefined;
  }

  return orgRole === "org:admin" ? "admin" : "member";
}

const requestState$ = computed(async (get) => {
  const request = get(request$);
  const clerk = get(clerk$);
  return clerk.authenticateRequest(request.raw, {
    acceptsToken: "session_token",
  });
});

export const clerkSessionAuth$: Computed<
  Promise<ClerkSessionAuthContext | null>
> = computed(async (get): Promise<ClerkSessionAuthContext | null> => {
  const requestState = await get(requestState$);

  if (!requestState.isAuthenticated) {
    return null;
  }

  const auth = requestState.toAuth();
  const orgRole = mapClerkOrgRole(auth.orgRole);

  if (auth.orgId && orgRole) {
    return {
      tokenType: "session",
      userId: auth.userId,
      orgId: auth.orgId,
      orgRole,
    };
  }

  return {
    tokenType: "session",
    userId: auth.userId,
  };
});
