import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { and, eq, gt } from "drizzle-orm";
import { computed, type Computed } from "ccstate";

import { request$ } from "../context/hono";
import { db$ } from "../external/db";
import { membershipsByUserId } from "../external/clerk";
import { now, nowDate } from "../external/time";
import {
  isPatToken,
  isSandboxToken,
  verifyCliToken,
  verifySandboxToken,
  verifyZeroToken,
  type CliAuth,
  type ZeroCapability,
} from "./tokens";
import { clerkSessionAuth$, type ApiOrgRole } from "./clerk-session";

type SessionAuthContext =
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

interface PatAuthContext {
  readonly tokenType: "pat";
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: ApiOrgRole;
}

interface SandboxAuthContext {
  readonly tokenType: "sandbox";
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}

interface ZeroAuthContext {
  readonly tokenType: "zero";
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: ApiOrgRole;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}

type AuthContext =
  | SessionAuthContext
  | PatAuthContext
  | SandboxAuthContext
  | ZeroAuthContext;

interface AuthOptions {
  readonly requiredCapability?: ZeroCapability;
  readonly acceptAnySandboxCapability?: boolean;
}

type AuthErrorResponse = {
  readonly status: 401 | 403;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

interface CliTokenRecord {
  readonly userId: string;
  readonly orgId: string;
}

export const authorizationHeader$ = computed((get) => {
  return get(request$).header("authorization");
});

function mapClerkRole(role: string): ApiOrgRole {
  return role === "org:admin" ? "admin" : "member";
}

function createMemberRole$(
  orgId: string,
  userId: string,
): Computed<Promise<{ role: ApiOrgRole } | null>> {
  return computed(async (get): Promise<{ role: ApiOrgRole } | null> => {
    const db = get(db$);
    const [cached] = await db
      .select({
        role: orgMembersCache.role,
        cachedAt: orgMembersCache.cachedAt,
      })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      )
      .limit(1);

    const currentTime = now();
    if (cached && currentTime - cached.cachedAt.getTime() < 60_000) {
      const role: ApiOrgRole = cached.role === "admin" ? "admin" : "member";
      return { role };
    }

    const memberships = await get(membershipsByUserId(userId));
    const membership = memberships.data.find((candidate) => {
      return candidate.organization.id === orgId;
    });

    if (!membership) {
      return null;
    }

    const role = mapClerkRole(membership.role);
    return { role };
  });
}

export function createCliTokenRecord$(
  cliAuth: CliAuth,
): Computed<Promise<CliTokenRecord | null>> {
  return computed(async (get): Promise<CliTokenRecord | null> => {
    const db = get(db$);
    const currentDate = nowDate();
    const [record] = await db
      .select()
      .from(cliTokens)
      .where(
        and(
          eq(cliTokens.id, cliAuth.tokenId),
          gt(cliTokens.expiresAt, currentDate),
        ),
      )
      .limit(1);

    if (!record) {
      return null;
    }

    return {
      userId: cliAuth.userId,
      orgId: cliAuth.orgId,
    };
  });
}

function createCliAuth$(
  cliAuth: CliAuth,
): Computed<Promise<AuthContext | null>> {
  return computed(async (get): Promise<AuthContext | null> => {
    const resolved = await get(createCliTokenRecord$(cliAuth));
    if (!resolved) {
      return null;
    }

    const membership = await get(
      createMemberRole$(resolved.orgId, resolved.userId),
    );
    if (!membership) {
      return null;
    }

    return {
      tokenType: "pat",
      userId: resolved.userId,
      orgId: resolved.orgId,
      orgRole: membership.role,
    };
  });
}

function resolveSandboxAuth(
  token: string,
  options: AuthOptions,
): AuthContext | null {
  const sandboxAuth = verifySandboxToken(token);
  if (!sandboxAuth) {
    return null;
  }

  if (options.acceptAnySandboxCapability) {
    return {
      tokenType: "sandbox",
      userId: sandboxAuth.userId,
      orgId: sandboxAuth.orgId,
      runId: sandboxAuth.runId,
    };
  }

  return null;
}

function createZeroAuth$(
  token: string,
  options: AuthOptions,
): Computed<Promise<AuthContext | null>> {
  return computed(async (get): Promise<AuthContext | null> => {
    const zeroAuth = verifyZeroToken(token);
    if (!zeroAuth) {
      return null;
    }

    if (!options.acceptAnySandboxCapability) {
      const hasCapability = zeroAuth.capabilities.some((capability) => {
        return capability === options.requiredCapability;
      });
      if (!hasCapability) {
        return null;
      }
    }

    const result: ZeroAuthContext = {
      tokenType: "zero",
      userId: zeroAuth.userId,
      orgId: zeroAuth.orgId,
      runId: zeroAuth.runId,
      capabilities: [...zeroAuth.capabilities],
    };

    const membership = await get(
      createMemberRole$(zeroAuth.orgId, zeroAuth.userId),
    );
    if (!membership) {
      return result;
    }

    return { ...result, orgRole: membership.role };
  });
}

function createSandboxTokenAuth$(
  token: string,
  options: AuthOptions,
): Computed<Promise<AuthContext | null>> {
  return computed(async (get): Promise<AuthContext | null> => {
    if (!options.requiredCapability && !options.acceptAnySandboxCapability) {
      return null;
    }

    return (
      resolveSandboxAuth(token, options) ??
      (await get(createZeroAuth$(token, options)))
    );
  });
}

function createResolvedAuthContext$(
  authHeader: string | undefined,
  options: AuthOptions,
): Computed<Promise<AuthContext | null>> {
  return computed(async (get): Promise<AuthContext | null> => {
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);

      if (isPatToken(token)) {
        const cliAuth = verifyCliToken(token);
        return cliAuth ? get(createCliAuth$(cliAuth)) : null;
      }

      if (isSandboxToken(token)) {
        const cliAuth = verifyCliToken(token);
        if (cliAuth) {
          return get(createCliAuth$(cliAuth));
        }

        return get(createSandboxTokenAuth$(token, options));
      }
    }

    return get(clerkSessionAuth$);
  });
}

export function createAuthContext$(
  options: AuthOptions = {},
): Computed<Promise<AuthContext | null>> {
  return computed(async (get) => {
    return get(createResolvedAuthContext$(get(authorizationHeader$), options));
  });
}

function missingCapabilityError(capability: ZeroCapability): AuthErrorResponse {
  return {
    status: 403,
    body: {
      error: {
        message: `Missing required capability: ${capability}`,
        code: "FORBIDDEN",
      },
    },
  };
}

function sandboxTokenAuthError(
  token: string,
  options: AuthOptions,
): AuthErrorResponse | null {
  if (!isSandboxToken(token)) {
    return null;
  }

  const sandboxAuth = verifySandboxToken(token);
  const zeroAuth = sandboxAuth ? null : verifyZeroToken(token);
  if (!sandboxAuth && !zeroAuth) {
    return null;
  }

  if (options.requiredCapability) {
    return missingCapabilityError(options.requiredCapability);
  }

  return {
    status: 403,
    body: {
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    },
  };
}

export function createRequiredAuthContext$(
  options: AuthOptions = {},
): Computed<Promise<AuthContext | AuthErrorResponse>> {
  return computed(async (get): Promise<AuthContext | AuthErrorResponse> => {
    const authHeader = get(authorizationHeader$);
    const authContext = await get(
      createResolvedAuthContext$(authHeader, options),
    );
    if (authContext) {
      return authContext;
    }

    if (authHeader?.startsWith("Bearer ")) {
      const error = sandboxTokenAuthError(authHeader.substring(7), options);
      if (error) {
        return error;
      }
    }

    return {
      status: 401 as const,
      body: {
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      },
    };
  });
}

export const apiKeyAuthContext$: Computed<
  Promise<AuthContext | AuthErrorResponse>
> = computed(async (get) => {
  const unauthorized: AuthErrorResponse = {
    status: 401,
    body: {
      error: { message: "API key required", code: "UNAUTHORIZED" },
    },
  };

  const authHeader = get(authorizationHeader$);
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorized;
  }

  const token = authHeader.substring(7);
  if (!isPatToken(token)) {
    return unauthorized;
  }

  const authContext = await get(createResolvedAuthContext$(authHeader, {}));
  if (!authContext || authContext.tokenType !== "pat") {
    return unauthorized;
  }

  return authContext;
});
