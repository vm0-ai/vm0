import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { command } from "ccstate";

import { badRequestMessage, notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";
import {
  DESKTOP_AUTH_SIGN_IN_TICKET_TTL_SECONDS,
  buildDesktopAuthCallbackUrl,
  completeDesktopAuthHandoff,
  consumeDesktopAuthHandoffCode,
  createDesktopAuthHandoffCode,
  getDesktopAuthHandoffStatus,
  isDesktopAuthHandoffCodeError,
} from "../services/desktop-auth.service";
import { settle } from "../utils";

const createBody$ = bodyResultOf(desktopAuthHandoffContract.create);
const statusParams$ = pathParamsOf(desktopAuthHandoffContract.status);
const completeParams$ = pathParamsOf(desktopAuthHandoffContract.complete);
const consumeBody$ = bodyResultOf(desktopAuthConsumeContract.consume);

const createDesktopAuthHandoff$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(createBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const auth = get(authContext$);
    const writeDb = set(writeDb$);
    const handoff = await createDesktopAuthHandoffCode(writeDb, {
      userId: auth.userId,
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        callbackUrl: buildDesktopAuthCallbackUrl(
          handoff.code,
          handoff.handoffId,
          bodyResult.data?.callbackScheme,
        ),
        handoffId: handoff.handoffId,
      },
    };
  },
);

const getDesktopAuthHandoffStatus$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(statusParams$);
    const status = await getDesktopAuthHandoffStatus(set(writeDb$), {
      handoffId: params.handoffId,
      userId: auth.userId,
    });
    signal.throwIfAborted();

    if (!status) {
      return notFound("Desktop sign-in handoff not found");
    }

    return {
      status: 200 as const,
      body: { status },
    };
  },
);

const completeDesktopAuthHandoff$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(completeParams$);
    const completed = await completeDesktopAuthHandoff(set(writeDb$), {
      handoffId: params.handoffId,
      userId: auth.userId,
    });
    signal.throwIfAborted();

    if (!completed) {
      return notFound("Desktop sign-in handoff not found");
    }

    return {
      status: 200 as const,
      body: { status: "completed" as const },
    };
  },
);

const consumeDesktopAuthHandoff$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(consumeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const consumed = await settle(
      consumeDesktopAuthHandoffCode(set(writeDb$), bodyResult.data),
      signal,
    );
    if (!consumed.ok) {
      if (isDesktopAuthHandoffCodeError(consumed.error)) {
        return badRequestMessage(consumed.error.message);
      }
      throw consumed.error;
    }

    const clerk = get(clerk$);
    const signInToken = await clerk.signInTokens.createSignInToken({
      userId: consumed.value,
      expiresInSeconds: DESKTOP_AUTH_SIGN_IN_TICKET_TTL_SECONDS,
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { token: signInToken.token },
    };
  },
);

export const desktopAuthRoutes: readonly RouteEntry[] = [
  {
    route: desktopAuthHandoffContract.create,
    handler: authRoute({ accept: ["session"] }, createDesktopAuthHandoff$),
  },
  {
    route: desktopAuthHandoffContract.status,
    handler: authRoute({ accept: ["session"] }, getDesktopAuthHandoffStatus$),
  },
  {
    route: desktopAuthHandoffContract.complete,
    handler: authRoute({ accept: ["session"] }, completeDesktopAuthHandoff$),
  },
  {
    route: desktopAuthConsumeContract.consume,
    handler: consumeDesktopAuthHandoff$,
  },
];
