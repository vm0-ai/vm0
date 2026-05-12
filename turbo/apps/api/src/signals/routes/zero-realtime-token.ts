import { command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";

import { requiredAuthContext$, setAuthContext$ } from "../auth/auth-context";
import { createPlatformUserRealtimeToken } from "../external/realtime";
import type { RouteEntry } from "../route";

const unauthenticated = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Authentication required",
      code: "UNAUTHORIZED",
    }),
  }),
});

const createInner$ = command(async ({ set }, signal: AbortSignal) => {
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();
  if ("status" in auth) {
    return unauthenticated;
  }

  set(setAuthContext$, auth);

  const tokenRequest = await createPlatformUserRealtimeToken(auth.userId);
  signal.throwIfAborted();

  return { status: 200 as const, body: tokenRequest };
});

export const zeroRealtimeTokenRoutes: readonly RouteEntry[] = [
  {
    route: platformRealtimeTokenContract.create,
    handler: createInner$,
  },
];
