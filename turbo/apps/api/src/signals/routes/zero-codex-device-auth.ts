import { command } from "ccstate";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  cancelCodexDeviceAuth$,
  codexDeviceAuthUnavailable,
  completeCodexDeviceAuth$,
  startCodexDeviceAuth,
} from "../services/codex-device-auth.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
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

const codexDeviceAuthDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Codex device auth is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function isCodexDeviceAuthEnabled(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): boolean {
  return isFeatureEnabled(FeatureSwitchKey.CodexDeviceAuth, {
    orgId: params.orgId,
    userId: params.userId,
    overrides: params.overrides,
  });
}

const startCodexDeviceAuthBody$ = bodyResultOf(
  zeroCodexDeviceAuthContract.start,
);
const completeCodexDeviceAuthBody$ = bodyResultOf(
  zeroCodexDeviceAuthContract.complete,
);
const cancelCodexDeviceAuthBody$ = bodyResultOf(
  zeroCodexDeviceAuthContract.cancel,
);

const startCodexDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    if (
      !isCodexDeviceAuthEnabled({
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return codexDeviceAuthDisabled;
    }

    const body = await get(startCodexDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (body.data.scope === "org" && auth.orgRole !== "admin") {
      return adminRequired;
    }

    const result = await startCodexDeviceAuth({
      writeDb: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      scope: body.data.scope,
      signal,
    });
    signal.throwIfAborted();

    if (!result.ok) {
      return codexDeviceAuthUnavailable(result.message);
    }

    return {
      status: 200 as const,
      body: {
        sessionToken: result.sessionToken,
        type: "codex" as const,
        status: "pending" as const,
        scope: result.scope,
        browserUrl: result.browserUrl,
        verificationCode: result.verificationCode,
        expiresIn: result.expiresIn,
        interval: result.interval,
      },
    };
  },
);

const completeCodexDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(completeCodexDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    if (
      !isCodexDeviceAuthEnabled({
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return codexDeviceAuthDisabled;
    }

    const result = await set(
      completeCodexDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        orgRole: auth.orgRole,
        sessionToken: body.data.sessionToken,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.status) {
      case "pending": {
        return {
          status: 200 as const,
          body: {
            status: "pending" as const,
            errorMessage: result.errorMessage,
          },
        };
      }
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
      case "auth_error": {
        return result.response;
      }
      case "error": {
        return codexDeviceAuthUnavailable(result.message);
      }
    }
  },
);

const cancelCodexDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(cancelCodexDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      cancelCodexDeviceAuth$,
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

export const zeroCodexDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: zeroCodexDeviceAuthContract.start,
    handler: authRoute(modelProviderWriteAuth, startCodexDeviceAuthInner$),
  },
  {
    route: zeroCodexDeviceAuthContract.complete,
    handler: authRoute(modelProviderWriteAuth, completeCodexDeviceAuthInner$),
  },
  {
    route: zeroCodexDeviceAuthContract.cancel,
    handler: authRoute(modelProviderWriteAuth, cancelCodexDeviceAuthInner$),
  },
];
