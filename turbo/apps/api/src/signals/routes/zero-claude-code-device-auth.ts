import { command } from "ccstate";
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  cancelClaudeCodeDeviceAuth$,
  claudeCodeDeviceAuthUnavailable,
  completeClaudeCodeDeviceAuth$,
  startClaudeCodeDeviceAuth,
} from "../services/claude-code-device-auth.service";
import type { RouteEntry } from "../route";

const modelProviderWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can manage org model providers",
      code: "FORBIDDEN",
    }),
  }),
});

const startClaudeCodeDeviceAuthBody$ = bodyResultOf(
  zeroClaudeCodeDeviceAuthContract.start,
);
const completeClaudeCodeDeviceAuthBody$ = bodyResultOf(
  zeroClaudeCodeDeviceAuthContract.complete,
);
const cancelClaudeCodeDeviceAuthBody$ = bodyResultOf(
  zeroClaudeCodeDeviceAuthContract.cancel,
);

const startClaudeCodeDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(startClaudeCodeDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (body.data.scope === "org" && auth.orgRole !== "admin") {
      return adminRequired;
    }

    const result = await startClaudeCodeDeviceAuth({
      writeDb: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      scope: body.data.scope,
      signal,
    });
    signal.throwIfAborted();

    if (!result.ok) {
      return claudeCodeDeviceAuthUnavailable(result.message);
    }

    return {
      status: 200 as const,
      body: {
        sessionToken: result.sessionToken,
        type: "claude-code" as const,
        status: "pending" as const,
        scope: result.scope,
        browserUrl: result.browserUrl,
        expiresIn: result.expiresIn,
      },
    };
  },
);

const completeClaudeCodeDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(completeClaudeCodeDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      completeClaudeCodeDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        orgRole: auth.orgRole,
        sessionToken: body.data.sessionToken,
        authorizationCode: body.data.authorizationCode,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.status) {
      case "complete": {
        return {
          status: 200 as const,
          body: {
            status: "complete" as const,
            provider: result.body.provider,
            created: result.body.created,
          },
        };
      }
      case "invalid_token": {
        return badRequestMessage(result.message);
      }
      case "forbidden": {
        return notFound(result.message);
      }
      case "error": {
        return claudeCodeDeviceAuthUnavailable(result.message);
      }
    }
  },
);

const cancelClaudeCodeDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(cancelClaudeCodeDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      cancelClaudeCodeDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        sessionToken: body.data.sessionToken,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.status) {
      case "cancelled": {
        return {
          status: 200 as const,
          body: { status: "cancelled" as const },
        };
      }
      case "invalid_token": {
        return badRequestMessage(result.message);
      }
      case "forbidden": {
        return notFound(result.message);
      }
    }
  },
);

export const zeroClaudeCodeDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: zeroClaudeCodeDeviceAuthContract.start,
    handler: authRoute(modelProviderWriteAuth, startClaudeCodeDeviceAuthInner$),
  },
  {
    route: zeroClaudeCodeDeviceAuthContract.complete,
    handler: authRoute(
      modelProviderWriteAuth,
      completeClaudeCodeDeviceAuthInner$,
    ),
  },
  {
    route: zeroClaudeCodeDeviceAuthContract.cancel,
    handler: authRoute(
      modelProviderWriteAuth,
      cancelClaudeCodeDeviceAuthInner$,
    ),
  },
];
