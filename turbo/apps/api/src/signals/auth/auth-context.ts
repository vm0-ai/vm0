import { command, computed, state, type Computed } from "ccstate";

import { waitUntil } from "../context/wait-until";
import {
  isPatToken,
  isSandboxToken,
  verifyCliToken,
  verifySandboxToken,
  verifyZeroToken,
} from "./tokens";
import { clerkSessionAuth$ } from "./clerk-session";
import { ZeroCapability } from "@vm0/api-contracts";
import { AuthContext, CliAuth, ZeroAuthContext } from "../../types/auth";
import {
  cliTokenRecord,
  getMemberRoleAndUpdateCache$,
  updateCliTokenLastUsedAt$,
} from "../services/auth.service";
import { authorization$, cookie$ } from "../context/hono";

export interface AuthOptions {
  readonly requiredCapability?: ZeroCapability;
  readonly acceptAnySandboxCapability?: boolean;
}

export type AuthErrorResponse = {
  readonly status: 401 | 403;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

const innerAuthContext$ = state<AuthContext | null>(null);

export const authContext$: Computed<AuthContext> = computed((get) => {
  const ctx = get(innerAuthContext$);
  if (ctx === null) {
    throw new Error("authContext$ accessed outside an authRoute scope");
  }
  return ctx;
});

export const setAuthContext$ = command(({ set }, ctx: AuthContext): void => {
  set(innerAuthContext$, ctx);
});

const cliAuth$ = command(
  async (
    { get, set },
    cliAuth: CliAuth,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const resolved = await get(cliTokenRecord(cliAuth));
    signal.throwIfAborted();
    if (!resolved) {
      return null;
    }

    waitUntil(set(updateCliTokenLastUsedAt$, cliAuth.tokenId, signal));

    const membership = await set(
      getMemberRoleAndUpdateCache$,
      resolved.orgId,
      resolved.userId,
      signal,
    );
    if (!membership) {
      return {
        tokenType: "pat",
        userId: resolved.userId,
      };
    }

    return {
      tokenType: "pat",
      userId: resolved.userId,
      orgId: resolved.orgId,
      orgRole: membership.role,
    };
  },
);

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

const zeroAuth$ = command(
  async (
    { set },
    token: string,
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const zeroAuth = verifyZeroToken(token);
    if (!zeroAuth) {
      return null;
    }

    if (!options.acceptAnySandboxCapability && options.requiredCapability) {
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

    const membership = await set(
      getMemberRoleAndUpdateCache$,
      zeroAuth.orgId,
      zeroAuth.userId,
      signal,
    );
    if (!membership) {
      return result;
    }

    return { ...result, orgRole: membership.role };
  },
);

const sandboxTokenAuth$ = command(
  async (
    { set },
    token: string,
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    // Zero tokens carry their own capabilities — evaluate before the
    // sandbox capability guard so they work on routes that don't
    // declare acceptAnySandboxCapability.
    const zeroResult = await set(zeroAuth$, token, options, signal);
    if (zeroResult) {
      return zeroResult;
    }

    if (!options.requiredCapability && !options.acceptAnySandboxCapability) {
      return null;
    }

    const sandboxAuth = resolveSandboxAuth(token, options);
    if (sandboxAuth) {
      return sandboxAuth;
    }

    return null;
  },
);

const resolvedAuthContext$ = command(
  async (
    { get, set },
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const authHeader = get(authorization$);

    if (!authHeader?.startsWith("Bearer ")) {
      if (!get(cookie$)) {
        return null;
      }
      return await get(clerkSessionAuth$);
    }

    const token = authHeader.substring(7);

    if (isPatToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (cliAuth) {
        const result = await set(cliAuth$, cliAuth, signal);
        if (result) {
          return result;
        }
      }
      // Recognized PAT prefix that failed verification or DB lookup must not
      // fall through to Clerk session auth — match web's `requireApiKeyAuth`
      // semantics so a bogus/expired PAT alongside a valid Clerk cookie is
      // still rejected.
      return null;
    }

    if (isSandboxToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (!cliAuth) {
        const result = await set(sandboxTokenAuth$, token, options, signal);
        if (result) {
          return result;
        }
      } else {
        const result = await set(cliAuth$, cliAuth, signal);
        if (result) {
          return result;
        }
      }
      return null;
    }

    // Unrecognized Bearer shape (e.g. a Clerk session JWT forwarded by the
    // platform api-client) — defer to Clerk session auth, which validates
    // both the Authorization header and the cookie.
    return await get(clerkSessionAuth$);
  },
);

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

export const requiredAuthContext$ = command(
  async (
    { get, set },
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | AuthErrorResponse> => {
    const authHeader = get(authorization$);
    const authContext = await set(resolvedAuthContext$, options, signal);
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
  },
);
