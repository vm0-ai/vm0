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
  memberRole,
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
    if (!resolved) {
      return null;
    }

    waitUntil(set(updateCliTokenLastUsedAt$, cliAuth.tokenId, signal));

    const membership = await get(memberRole(resolved.orgId, resolved.userId));
    if (!membership) {
      return null;
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

function zeroAuth(
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

    const membership = await get(memberRole(zeroAuth.orgId, zeroAuth.userId));
    if (!membership) {
      return result;
    }

    return { ...result, orgRole: membership.role };
  });
}

function sandboxTokenAuth(
  token: string,
  options: AuthOptions,
): Computed<Promise<AuthContext | null>> {
  return computed(async (get): Promise<AuthContext | null> => {
    if (!options.requiredCapability && !options.acceptAnySandboxCapability) {
      return null;
    }

    return (
      resolveSandboxAuth(token, options) ??
      (await get(zeroAuth(token, options)))
    );
  });
}

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
      if (!cliAuth) {
        return null;
      }

      return await set(cliAuth$, cliAuth, signal);
    }

    if (isSandboxToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (!cliAuth) {
        return await get(sandboxTokenAuth(token, options));
      }

      return await set(cliAuth$, cliAuth, signal);
    }

    return null;
  },
);

export const createAuthContext$ = command(
  async (
    { set },
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    return await set(resolvedAuthContext$, options, signal);
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

export const apiKeyAuthContext$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<AuthContext | AuthErrorResponse> => {
    const UNAUTHORIZED: AuthErrorResponse = {
      status: 401,
      body: {
        error: { message: "API key required", code: "UNAUTHORIZED" },
      },
    };

    const authHeader = get(authorization$);
    if (!authHeader?.startsWith("Bearer ")) {
      return UNAUTHORIZED;
    }

    const token = authHeader.substring(7);
    if (!isPatToken(token)) {
      return UNAUTHORIZED;
    }

    const authContext = await set(resolvedAuthContext$, {}, signal);
    if (!authContext || authContext.tokenType !== "pat") {
      return UNAUTHORIZED;
    }

    return authContext;
  },
);
