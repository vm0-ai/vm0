import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { adAttributionMetadataSchema } from "./acquisition-attribution";

const c = initContract();

// Operator inspection during #33452. A projection is not proof of current
// identity, permission, consent, or readiness to switch marketing senders.
export const marketingAttributionImportContract = c.router({
  inspect: {
    method: "POST",
    path: "/api/internal/marketing/attribution/import",
    headers: authHeadersSchema,
    body: z
      .object({
        userId: z.string().min(1).max(128),
        afterTransactionId: z.string().max(512).optional(),
      })
      .strict(),
    responses: {
      200: z.object({
        state: z.enum([
          "not_imported",
          "absent",
          "captured",
          "invalid",
          "conflict",
          "deleted",
        ]),
        sourceUpdatedAt: z.iso.datetime().nullable(),
        attribution: adAttributionMetadataSchema.nullable(),
        privacyReceipt: z.string().nullable(),
        deliveries: z.array(
          z.object({
            transactionId: z.string(),
            latest: z.unknown(),
            accepted: z.unknown(),
            conflict: z.boolean(),
          }),
        ),
        nextTransactionId: z.string().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Inspect the imported Clerk attribution projection without authorizing delivery",
  },
});
