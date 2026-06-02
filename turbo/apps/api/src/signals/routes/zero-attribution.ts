import { command } from "ccstate";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route";

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const recordSignupBody$ = bodyResultOf(zeroAttributionContract.recordSignup);

const recordSignupInner$ = command(async ({ get }, signal: AbortSignal) => {
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
  if (
    Object.prototype.hasOwnProperty.call(
      privateMetadata,
      SIGNUP_ATTRIBUTION_KEY,
    )
  ) {
    return { status: 200 as const, body: { recorded: false } };
  }

  await clerk.users.updateUser(auth.userId, {
    privateMetadata: {
      ...privateMetadata,
      [SIGNUP_ATTRIBUTION_KEY]: {
        ...bodyResult.data.attribution,
        recorded_at: nowDate().toISOString(),
      },
    },
  });
  signal.throwIfAborted();

  return { status: 200 as const, body: { recorded: true } };
});

export const zeroAttributionRoutes: readonly RouteEntry[] = [
  {
    route: zeroAttributionContract.recordSignup,
    handler: authRoute({ accept: ["session"] }, recordSignupInner$),
  },
];
