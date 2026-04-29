import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { composeResponseSchema, composeListItemSchema } from "./composes";

const c = initContract();

/**
 * Zero composes main contract (GET /api/zero/composes)
 * Proxies to composesMainContract.getByName
 */
export const zeroComposesMainContract = c.router({
  getByName: {
    method: "GET",
    path: "/api/zero/composes",
    headers: authHeadersSchema,
    query: z.object({
      name: z.string().min(1, "Missing name query parameter"),
    }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent compose by name (zero proxy)",
  },
});

/**
 * Zero composes by ID contract (GET/DELETE /api/zero/composes/:id)
 * Proxies to composesByIdContract
 */
export const zeroComposesByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/composes/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Compose ID is required"),
    }),
    responses: {
      200: composeResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent compose by ID (zero proxy)",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/composes/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Compose ID is required"),
    }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete agent compose (zero proxy)",
  },
});

/**
 * Zero composes list contract (GET /api/zero/composes/list)
 * Proxies to composesListContract
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

// Type exports
export type ZeroComposesMainContract = typeof zeroComposesMainContract;
export type ZeroComposesByIdContract = typeof zeroComposesByIdContract;
export type ZeroComposesListContract = typeof zeroComposesListContract;
