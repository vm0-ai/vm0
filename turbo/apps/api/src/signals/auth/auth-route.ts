import { command, type Command } from "ccstate";

import type { SignalRouteHandler } from "../context/route";
import type { AuthTokenType } from "../../types/auth";
import {
  requiredAuthContext$,
  setAuthContext$,
  type AuthErrorResponse,
  type AuthOptions,
} from "./auth-context";

interface AuthRouteOptions extends AuthOptions {
  readonly accept?: readonly AuthTokenType[];
}

const FORBIDDEN_TOKEN_TYPE: AuthErrorResponse = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "This endpoint does not accept the provided credential type",
      code: "FORBIDDEN",
    }),
  }),
});

function isCommand<T>(
  handler$: SignalRouteHandler<T>,
): handler$ is Command<T, [AbortSignal]> {
  return "write" in handler$;
}

export function authRoute<T>(
  options: AuthRouteOptions,
  handler$: SignalRouteHandler<T>,
): Command<Promise<T | AuthErrorResponse>, [AbortSignal]> {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<T | AuthErrorResponse> => {
      const result = await set(requiredAuthContext$, options, signal);
      if ("status" in result) {
        return result;
      }

      if (options.accept && !options.accept.includes(result.tokenType)) {
        return FORBIDDEN_TOKEN_TYPE;
      }

      set(setAuthContext$, result);

      return isCommand(handler$)
        ? await set(handler$, signal)
        : await get(handler$);
    },
  );
}
