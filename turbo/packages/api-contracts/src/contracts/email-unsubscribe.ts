import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const emailUnsubscribeQuerySchema = z.object({
  token: z.string().optional(),
});

export const emailUnsubscribeErrorSchema = z.object({
  error: z.string(),
});

export const emailUnsubscribeContract = c.router({
  get: {
    method: "GET",
    path: "/api/email/unsubscribe",
    query: emailUnsubscribeQuerySchema,
    responses: {
      200: c.otherResponse({
        contentType: "text/html",
        body: z.unknown(),
      }),
      400: emailUnsubscribeErrorSchema,
    },
    summary: "Unsubscribe from system email notifications",
  },
});

export type EmailUnsubscribeContract = typeof emailUnsubscribeContract;
export type EmailUnsubscribeQuery = z.infer<typeof emailUnsubscribeQuerySchema>;
