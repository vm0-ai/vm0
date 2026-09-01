import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testGmailWatchRenewalContract = c.router({
  cleanup: {
    method: "POST",
    path: "/api/test/gmail-watch-renewal/cleanup",
    body: z.object({
      provider_account_id: z.string().min(1),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        cleaned: z.number(),
        failed: z.number(),
      }),
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Process one provider account's Gmail cleanup in API tests",
  },
  renew: {
    method: "POST",
    path: "/api/test/gmail-watch-renewal/renew",
    body: z.object({
      email_address: z.string().min(1),
      topic_name: z.string().min(1),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        renewed: z.number(),
        failed: z.number(),
      }),
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Renew one Gmail watch scope in API tests",
  },
});

export type TestGmailWatchRenewalContract =
  typeof testGmailWatchRenewalContract;
