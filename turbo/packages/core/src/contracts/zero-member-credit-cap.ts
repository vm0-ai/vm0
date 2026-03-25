import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const memberCreditCapResponseSchema = z.object({
  userId: z.string(),
  creditCap: z.number().nullable(),
  creditEnabled: z.boolean(),
});

/**
 * Zero member credit cap contract (GET/PUT /api/zero/org/members/credit-cap)
 */
export const zeroMemberCreditCapContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/org/members/credit-cap",
    headers: authHeadersSchema,
    query: z.object({
      userId: z.string().min(1, "userId is required"),
    }),
    responses: {
      200: memberCreditCapResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Get member credit cap",
  },
  set: {
    method: "PUT",
    path: "/api/zero/org/members/credit-cap",
    headers: authHeadersSchema,
    body: z.object({
      userId: z.string().min(1),
      creditCap: z.number().int().positive().nullable(),
    }),
    responses: {
      200: memberCreditCapResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Set or clear member credit cap",
  },
});

export type ZeroMemberCreditCapContract = typeof zeroMemberCreditCapContract;
