import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const imageShareXRequestSchema = z.object({
  imageUrl: z.string().min(1),
  caption: z.string().max(280).optional(),
});

export const imageShareXResponseSchema = z.object({
  tweetId: z.string(),
  tweetUrl: z.string(),
});

export type ImageShareXRequest = z.infer<typeof imageShareXRequestSchema>;
export type ImageShareXResponse = z.infer<typeof imageShareXResponseSchema>;

export const imageShareXContract = c.router({
  post: {
    method: "POST",
    path: "/api/image-share/x",
    headers: authHeadersSchema,
    body: imageShareXRequestSchema,
    responses: {
      200: imageShareXResponseSchema,
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

export type ImageShareXContract = typeof imageShareXContract;
