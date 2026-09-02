import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testGoogleMeetSubscriptionRenewalContract = c.router({
  renew: {
    method: "POST",
    path: "/api/test/google-meet-subscription-renewal/renew",
    body: z.object({
      org_id: z.string().min(1),
      user_id: z.string().min(1),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        renewed: z.number(),
        repaired: z.number(),
        failed: z.number(),
      }),
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Renew one Google Meet subscription scope in API tests",
  },
});

export type TestGoogleMeetSubscriptionRenewalContract =
  typeof testGoogleMeetSubscriptionRenewalContract;
