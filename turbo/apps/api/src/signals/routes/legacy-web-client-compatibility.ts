import { command } from "ccstate";
import { z } from "zod";
import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";

import {
  isSupportedWebClientVersion,
  minimumSupportedWebClientVersion,
} from "../../lib/web-client-compatibility";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

const c = initContract();

const appVersionSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "Expected an app version like 1.229.0",
  );

const legacyWebClientCompatibilityContract = c.router({
  get: {
    method: "GET",
    path: "/api/client/compatibility",
    query: z.object({
      version: appVersionSchema,
    }),
    responses: {
      200: z.object({
        minimumSupportedVersion: appVersionSchema,
        supported: z.boolean(),
      }),
    },
    summary: "Check legacy web client version compatibility",
  },
});

const legacyWebClientCompatibilityQuery$ = queryOf(
  legacyWebClientCompatibilityContract.get,
);

const legacyWebClientCompatibility$ = command(({ get, set }) => {
  const query = get(legacyWebClientCompatibilityQuery$);

  set(setResHeader$, "Cache-Control", "no-store");

  return {
    status: 200,
    body: {
      minimumSupportedVersion: minimumSupportedWebClientVersion,
      supported: isSupportedWebClientVersion(query.version),
    },
  };
});

export const legacyWebClientCompatibilityRoutes = [
  {
    route: legacyWebClientCompatibilityContract.get,
    handler: legacyWebClientCompatibility$,
  },
] satisfies readonly RouteEntry[];
