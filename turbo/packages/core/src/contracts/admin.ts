import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const scopeTierSchema = z.enum(["free", "pro", "max"]);
export type ScopeTier = z.infer<typeof scopeTierSchema>;

export const setScopeTierRequestSchema = z.object({
  slug: z.string().min(1),
  tier: scopeTierSchema,
});

export const setScopeTierResponseSchema = z.object({
  slug: z.string(),
  tier: scopeTierSchema,
  updatedAt: z.string(),
});

export const adminScopeTierContract = c.router({
  setTier: {
    method: "PUT",
    path: "/api/admin/scope/tier",
    headers: authHeadersSchema,
    body: setScopeTierRequestSchema,
    responses: {
      200: setScopeTierResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set scope tier (admin only)",
  },
});

export type AdminScopeTierContract = typeof adminScopeTierContract;
