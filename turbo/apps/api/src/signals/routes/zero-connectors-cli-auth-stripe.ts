import { command } from "ccstate";
import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  completeCliAuthStripe$,
  startCliAuthStripe,
} from "../services/cli-auth-stripe.service";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const cliAuthStripeDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "CLI auth for Stripe is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function isCliAuthStripeEnabled(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): boolean {
  const switchContext = {
    orgId: params.orgId,
    userId: params.userId,
    overrides: params.overrides,
  };
  return isFeatureEnabled(FeatureSwitchKey.CliAuthStripe, switchContext);
}

const completeCliAuthStripeBody$ = bodyResultOf(
  zeroCliAuthStripeContract.complete,
);
const startCliAuthStripeBody$ = bodyResultOf(zeroCliAuthStripeContract.start);

function cliAuthStripeUnavailable(message: string, code: string) {
  return {
    status: 503 as const,
    body: {
      error: {
        message,
        code,
      },
    },
  };
}

const startCliAuthStripeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    if (
      !isCliAuthStripeEnabled({
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return cliAuthStripeDisabled;
    }

    const body = await get(startCliAuthStripeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await startCliAuthStripe({
      writeDb: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      mode: body.data.mode,
      signal,
    });
    signal.throwIfAborted();

    if (!result.ok) {
      return cliAuthStripeUnavailable(result.message, result.code);
    }

    return {
      status: 200 as const,
      body: {
        sessionToken: result.sessionToken,
        type: "stripe" as const,
        status: "pending" as const,
        mode: result.mode,
        browserUrl: result.browserUrl,
        verificationCode: result.verificationCode,
        expiresIn: result.expiresIn,
        interval: result.interval,
      },
    };
  },
);

const completeCliAuthStripeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(completeCliAuthStripeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    if (
      !isCliAuthStripeEnabled({
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return cliAuthStripeDisabled;
    }

    const result = await set(
      completeCliAuthStripe$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
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
            connector: result.connector,
          },
        };
      }
      case "invalid_token": {
        return badRequestMessage(result.message);
      }
      case "forbidden": {
        return notFound("CLI auth for Stripe session not found");
      }
      case "error": {
        return cliAuthStripeUnavailable(result.message, result.code);
      }
    }
  },
);

export const zeroCliAuthStripeRoutes: readonly RouteEntry[] = [
  {
    route: zeroCliAuthStripeContract.start,
    handler: authRoute(connectorWriteAuth, startCliAuthStripeInner$),
  },
  {
    route: zeroCliAuthStripeContract.complete,
    handler: authRoute(connectorWriteAuth, completeCliAuthStripeInner$),
  },
];
