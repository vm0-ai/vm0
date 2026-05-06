import { initContract } from "@ts-rest/core";
import { command } from "ccstate";
import { z } from "zod";

import {
  requiredAuthContext$,
  setAuthContext$,
  type AuthErrorResponse,
} from "../auth/auth-context";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import type { AuthContext, AuthTokenType } from "../../types/auth";
import type { RouteEntry } from "../route";
import { rawQuery$ } from "../context/hono";

const c = initContract();

const probeRoute = c.router({
  check: {
    method: "GET" as const,
    path: "/health/auth",
    headers: z.object({
      authorization: z.string().optional(),
      cookie: z.string().optional(),
    }),
    query: z.object({
      acceptAnySandboxCapability: z.string().optional(),
      requiredCapability: z.string().optional(),
      accept: z.string().optional(),
    }),
    responses: {
      200: z.unknown(),
      401: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
      403: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
    },
    summary: "Resolve auth context for the current request",
  },
});

const probe$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<
    { readonly status: 200; readonly body: AuthContext } | AuthErrorResponse
  > => {
    const query = get(rawQuery$);

    const options: {
      requiredCapability?: ZeroCapability;
      acceptAnySandboxCapability?: boolean;
      accept?: readonly AuthTokenType[];
    } = {};

    if (query.acceptAnySandboxCapability === "true") {
      options.acceptAnySandboxCapability = true;
    }
    if (query.requiredCapability) {
      options.requiredCapability = query.requiredCapability as ZeroCapability;
    }
    if (query.accept) {
      options.accept = query.accept.split(",") as AuthTokenType[];
    }

    const result = await set(requiredAuthContext$, options, signal);
    if ("status" in result) {
      // PAT-only routes: rewrite 401 message to match requireApiKeyAuth phrasing
      if (
        options.accept?.length === 1 &&
        options.accept[0] === "pat" &&
        result.status === 401
      ) {
        return {
          status: 401 as const,
          body: {
            error: { message: "API key required", code: "UNAUTHORIZED" },
          },
        };
      }
      return result;
    }

    // Post-filter: reject token types not in the accept list
    if (options.accept && !options.accept.includes(result.tokenType)) {
      if (options.accept.length === 1 && options.accept[0] === "pat") {
        return {
          status: 401 as const,
          body: {
            error: { message: "API key required", code: "UNAUTHORIZED" },
          },
        };
      }
      return {
        status: 403 as const,
        body: {
          error: {
            message:
              "This endpoint does not accept the provided credential type",
            code: "FORBIDDEN",
          },
        },
      };
    }

    set(setAuthContext$, result);
    return { status: 200 as const, body: result };
  },
);

export const healthAuthProbeRoutes: readonly RouteEntry[] = [
  { route: probeRoute.check, handler: probe$ },
];

export const healthAuthProbeContract = probeRoute;
