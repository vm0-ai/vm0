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

function isPatOnly(accept: readonly AuthTokenType[] | undefined): boolean {
  return accept?.length === 1 && accept[0] === "pat";
}

// PAT-only routes mirror web's `requireApiKeyAuth` 401 phrasing so the shadow
// comparison treats matching auth failures as identical. Other token types
// keep the generic "Not authenticated" copy from `requiredAuthContext$`.
function rewriteUnauthorizedForPat(
  result: AuthErrorResponse,
): AuthErrorResponse {
  if (result.status !== 401) return result;
  return {
    status: 401,
    body: {
      error: { message: "API key required", code: "UNAUTHORIZED" },
    },
  };
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
        return isPatOnly(options.accept)
          ? rewriteUnauthorizedForPat(result)
          : result;
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
