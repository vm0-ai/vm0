import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const appBootstrapResponseEntrySchema = z
  .object({
    method: z.literal("GET"),
    path: z.string().startsWith("/api/"),
    contentType: z.literal("application/json"),
    body: z.unknown(),
  })
  .strict();

export type AppBootstrapResponseEntry = z.infer<
  typeof appBootstrapResponseEntrySchema
>;

export const appBootstrapContract = c.router({
  get: {
    method: "GET",
    path: "/api/bootstrap",
    headers: authHeadersSchema,
    query: z
      .object({
        path: z.string().startsWith("/"),
      })
      .strict(),
    responses: {
      200: z
        .object({
          responses: z.array(appBootstrapResponseEntrySchema),
        })
        .strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get initial App API responses for a page",
  },
});

export type AppBootstrapContract = typeof appBootstrapContract;
