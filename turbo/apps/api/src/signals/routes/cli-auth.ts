import { randomInt } from "node:crypto";

import {
  cliAuthDeviceContract,
  cliAuthOrgContract,
  cliAuthTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  CLI_TOKEN_EXPIRES_IN_SECONDS,
  issueCliToken$,
  orgIdBySlug$,
} from "../services/cli-auth.service";

const DEVICE_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DEVICE_CODE_EXPIRES_IN_SECONDS = 900;
const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;

function generateDeviceCode(): string {
  const chars = Array.from({ length: 8 }, () => {
    return DEVICE_CODE_CHARS[randomInt(DEVICE_CODE_CHARS.length)];
  });
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function oauthError(
  status: 400 | 202 | 500,
  error: string,
  errorDescription: string,
) {
  return {
    status,
    body: { error, error_description: errorDescription },
  };
}

const tokenBody$ = bodyResultOf(cliAuthTokenContract.exchange);
const orgBody$ = bodyResultOf(cliAuthOrgContract.switchOrg);

const createDeviceInner$ = command(async ({ set }, signal: AbortSignal) => {
  const writeDb = set(writeDb$);
  const deviceCode = generateDeviceCode();
  const now = nowDate();
  const expiresAt = new Date(
    now.getTime() + DEVICE_CODE_EXPIRES_IN_SECONDS * 1000,
  );

  await writeDb.insert(deviceCodes).values({
    code: deviceCode,
    purpose: "cli",
    status: "pending",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      device_code: deviceCode,
      user_code: deviceCode,
      verification_path: "/cli-auth",
      expires_in: DEVICE_CODE_EXPIRES_IN_SECONDS,
      interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
    },
  };
});

const exchangeTokenInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(tokenBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return oauthError(
        400,
        "invalid_request",
        bodyResult.response.body.error.message,
      );
    }

    const writeDb = set(writeDb$);
    const deviceCode = bodyResult.data.device_code;
    const [session] = await writeDb
      .select()
      .from(deviceCodes)
      .where(
        and(eq(deviceCodes.code, deviceCode), eq(deviceCodes.purpose, "cli")),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return oauthError(400, "invalid_request", "Invalid device code");
    }

    if (nowDate() > session.expiresAt) {
      return oauthError(400, "expired_token", "The device code has expired");
    }

    switch (session.status) {
      case "pending": {
        return oauthError(
          202,
          "authorization_pending",
          "The user has not yet completed authorization in the browser",
        );
      }
      case "denied": {
        await writeDb
          .delete(deviceCodes)
          .where(eq(deviceCodes.code, deviceCode));
        signal.throwIfAborted();
        return oauthError(
          400,
          "access_denied",
          "The user denied the authorization request",
        );
      }
      case "authenticated": {
        const issued = await set(
          issueCliToken$,
          {
            userId: session.userId ?? "",
            orgId: session.orgId ?? "",
            name: "CLI Device Flow Authentication",
          },
          signal,
        );
        signal.throwIfAborted();

        await writeDb
          .delete(deviceCodes)
          .where(eq(deviceCodes.code, deviceCode));
        signal.throwIfAborted();

        return {
          status: 200 as const,
          body: {
            access_token: issued.token,
            token_type: "Bearer" as const,
            expires_in: issued.expiresIn,
          },
        };
      }
      default: {
        return oauthError(500, "server_error", "Unknown device code status");
      }
    }
  },
);

const switchOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(orgBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return oauthError(
      400,
      "invalid_request",
      bodyResult.response.body.error.message,
    );
  }

  const auth = get(authContext$);
  const orgId = await set(orgIdBySlug$, bodyResult.data.slug, signal);
  signal.throwIfAborted();
  if (!orgId) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Organization not found", code: "not_found" },
      },
    };
  }

  const membership = await set(
    getMemberRoleAndUpdateCache$,
    orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  if (!membership) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Not a member of this organization",
          code: "forbidden",
        },
      },
    };
  }

  const issued = await set(
    issueCliToken$,
    {
      userId: auth.userId,
      orgId,
      name: "CLI Org Switch",
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      access_token: issued.token,
      token_type: "Bearer" as const,
      expires_in: CLI_TOKEN_EXPIRES_IN_SECONDS,
    },
  };
});

const switchOrgWithPatAuth$ = authRoute({ accept: ["pat"] }, switchOrgInner$);

const switchOrgRoute$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await set(switchOrgWithPatAuth$, signal);
  if ("status" in result && result.status === 401) {
    return {
      status: 401 as const,
      body: {
        error: { message: "Authentication required", code: "unauthorized" },
      },
    };
  }

  return result;
});

export const cliAuthRoutes: readonly RouteEntry[] = [
  { route: cliAuthDeviceContract.create, handler: createDeviceInner$ },
  { route: cliAuthTokenContract.exchange, handler: exchangeTokenInner$ },
  {
    route: cliAuthOrgContract.switchOrg,
    handler: switchOrgRoute$,
  },
];
