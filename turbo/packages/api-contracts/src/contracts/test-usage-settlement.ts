import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testUsageSettlementRequestSchema = z.object({
  org_id: z.string().min(1),
});

export const testUsageSettlementResponseSchema = z.object({
  ok: z.literal(true),
});

export const testUsageSettlementContract = c.router({
  process: {
    method: "POST",
    path: "/api/test/usage-settlement/process",
    body: testUsageSettlementRequestSchema,
    responses: {
      200: testUsageSettlementResponseSchema,
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Process one organization's usage in API tests",
  },
});

export type TestUsageSettlementRequest = z.infer<
  typeof testUsageSettlementRequestSchema
>;
export type TestUsageSettlementResponse = z.infer<
  typeof testUsageSettlementResponseSchema
>;
export type TestUsageSettlementContract = typeof testUsageSettlementContract;
