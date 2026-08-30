import { command } from "ccstate";
import {
  acquisitionAttributionContract,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { nowDate } from "../../lib/time";
import {
  parseStoredSignupAttribution,
  persistOrgAcquisitionAttribution$,
} from "../services/acquisition-attribution.service";
import { googleAdsConversionMilestonesForUser$ } from "../services/google-ads-conversion-milestones.service";
import type { RouteEntry } from "../route-entry";

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const recordSignupBody$ = bodyResultOf(
  acquisitionAttributionContract.recordSignup,
);

const googleAdsMilestonesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const milestones = await set(
      googleAdsConversionMilestonesForUser$,
      auth.userId,
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { milestones } };
  },
);

const recordSignupInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(recordSignupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const clerk = get(clerk$);
    const users = await clerk.users.getUserList({
      userId: [auth.userId],
      limit: 1,
    });
    signal.throwIfAborted();

    const user = users.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    if (!user) {
      throw new Error(`No Clerk user found for user ${auth.userId}`);
    }

    const privateMetadata = isRecord(user.privateMetadata)
      ? user.privateMetadata
      : {};
    const existingAttribution = parseStoredSignupAttribution(
      privateMetadata[SIGNUP_ATTRIBUTION_KEY],
    );
    if (
      Object.prototype.hasOwnProperty.call(
        privateMetadata,
        SIGNUP_ATTRIBUTION_KEY,
      )
    ) {
      if (auth.orgId && existingAttribution) {
        await set(
          persistOrgAcquisitionAttribution$,
          {
            orgId: auth.orgId,
            attribution: existingAttribution,
          },
          signal,
        );
      }
      return { status: 200 as const, body: { recorded: false } };
    }

    const attribution: AdAttributionMetadata = bodyResult.data.attribution;
    await clerk.users.updateUserMetadata(auth.userId, {
      privateMetadata: {
        ...privateMetadata,
        [SIGNUP_ATTRIBUTION_KEY]: {
          ...attribution,
          recorded_at: nowDate().toISOString(),
        },
      },
    });
    signal.throwIfAborted();

    if (auth.orgId) {
      await set(
        persistOrgAcquisitionAttribution$,
        { orgId: auth.orgId, attribution },
        signal,
      );
    }

    return { status: 200 as const, body: { recorded: true } };
  },
);

export const acquisitionAttributionRoutes: readonly RouteEntry[] = [
  {
    route: acquisitionAttributionContract.googleAdsMilestones,
    handler: authRoute({ accept: ["session"] }, googleAdsMilestonesInner$),
  },
  {
    route: acquisitionAttributionContract.recordSignup,
    handler: authRoute({ accept: ["session"] }, recordSignupInner$),
  },
];
