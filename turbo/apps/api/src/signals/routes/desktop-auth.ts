import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { command } from "ccstate";

import { badRequestMessage } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";
import {
  DESKTOP_AUTH_SIGN_IN_TICKET_TTL_SECONDS,
  buildDesktopAuthCallbackUrl,
  consumeDesktopAuthHandoffCode,
  createDesktopAuthHandoffCode,
  isDesktopAuthHandoffCodeError,
} from "../services/desktop-auth.service";
import { settle } from "../utils";

const createBody$ = bodyResultOf(desktopAuthHandoffContract.create);
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
    const code = await createDesktopAuthHandoffCode(writeDb, {
      userId: auth.userId,
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        callbackUrl: buildDesktopAuthCallbackUrl(
          code,
          bodyResult.data?.callbackScheme,
        ),
      },
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
    route: desktopAuthConsumeContract.consume,
    handler: consumeDesktopAuthHandoff$,
  },
];
