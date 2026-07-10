import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroImageShareXRequestSchema = z.object({
  imageUrl: z.string().min(1),
  caption: z.string().max(280).optional(),
});

export const zeroImageShareXResponseSchema = z.object({
  tweetId: z.string(),
  tweetUrl: z.string(),
});

export type ZeroImageShareXRequest = z.infer<
  typeof zeroImageShareXRequestSchema
>;
export type ZeroImageShareXResponse = z.infer<
  typeof zeroImageShareXResponseSchema
>;

export const zeroImageShareXContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/image-share/x",
    headers: authHeadersSchema,
    body: zeroImageShareXRequestSchema,
    responses: {
      200: zeroImageShareXResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Share an image to X",
  },
});

export type ZeroImageShareXContract = typeof zeroImageShareXContract;
