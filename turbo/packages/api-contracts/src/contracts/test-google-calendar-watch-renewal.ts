import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testGoogleCalendarWatchRenewalContract = c.router({
  renew: {
    method: "POST",
    path: "/api/test/google-calendar-watch-renewal/renew",
    body: z.object({
      org_id: z.string().min(1),
      user_id: z.string().min(1),
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
    summary: "Renew one Google Calendar watch owner in API tests",
  },
});

export type TestGoogleCalendarWatchRenewalContract =
  typeof testGoogleCalendarWatchRenewalContract;
