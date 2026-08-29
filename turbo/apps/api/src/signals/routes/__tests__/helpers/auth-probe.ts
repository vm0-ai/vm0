import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { command } from "ccstate";
import { z } from "zod";

import {
  requiredAuthContext$,
  setAuthContext$,
  type AuthErrorResponse,
} from "../../../auth/auth-context";
import { rawQuery$ } from "../../../context/hono";
import type { RouteEntry } from "../../../route-entry";

const c = initContract();

export const testAuthProbeContract = c.router({
  check: {
    method: "GET" as const,
    path: "/api/test/auth-probe",
    headers: z.object({
      authorization: z.string().optional(),
      cookie: z.string().optional(),
    }),
    query: z.object({
      acceptAnySandboxCapability: z.string().optional(),
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
  },
});

const probe$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<
    { readonly status: 200; readonly body: unknown } | AuthErrorResponse
  > => {
    const query = get(rawQuery$);
    const result = await set(
      requiredAuthContext$,
      query.acceptAnySandboxCapability === "true"
        ? { acceptAnySandboxCapability: true }
        : {},
      signal,
    );
    if ("status" in result) {
      return result;
    }

    set(setAuthContext$, result);
    return { status: 200 as const, body: result };
  },
);

export const testAuthProbeRoutes: readonly RouteEntry[] = [
  { route: testAuthProbeContract.check, handler: probe$ },
];
