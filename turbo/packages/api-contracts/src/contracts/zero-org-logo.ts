import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroOrgLogoResponseSchema = z.object({
  logoUrl: z.string().nullable(),
  hasImage: z.boolean(),
});

export type ZeroOrgLogoResponse = z.infer<typeof zeroOrgLogoResponseSchema>;

/**
 * Zero contract for GET /api/zero/org/logo
 */
export const zeroOrgLogoContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/org/logo",
    headers: authHeadersSchema,
    responses: {
      200: zeroOrgLogoResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get current organization logo",
  },
});

export type ZeroOrgLogoContract = typeof zeroOrgLogoContract;
