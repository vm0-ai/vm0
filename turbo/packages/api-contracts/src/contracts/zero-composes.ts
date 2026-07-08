import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { composeListItemSchema } from "./composes";

const c = initContract();

/**
 * Zero composes list contract (GET /api/zero/composes/list)
 */
export const zeroComposesListContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/composes/list",
    headers: authHeadersSchema,
    query: z.object({}),
    responses: {
      200: z.object({
        composes: z.array(composeListItemSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List all agent composes (zero proxy)",
  },
});

export type ZeroComposesListContract = typeof zeroComposesListContract;
