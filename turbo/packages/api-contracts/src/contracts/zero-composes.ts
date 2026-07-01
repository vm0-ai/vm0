import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { composeResponseSchema, composeListItemSchema } from "./composes";

const c = initContract();

/**
 * Zero composes by ID contract (GET /api/zero/composes/:id)
 * Proxies to composesByIdContract
 */
export const zeroComposesByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/composes/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Compose ID must be a valid UUID"),
    }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent compose by ID (zero proxy)",
  },
});

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

export type ZeroComposesByIdContract = typeof zeroComposesByIdContract;
export type ZeroComposesListContract = typeof zeroComposesListContract;
