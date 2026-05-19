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
 * Zero contract for /api/zero/org/logo
 */
export const zeroOrgLogoContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/org/logo",
    headers: authHeadersSchema,
    responses: {
      200: zeroOrgLogoResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get current organization logo",
  },
  post: {
    method: "POST",
    path: "/api/zero/org/logo",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: zeroOrgLogoResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Upload current organization logo",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/org/logo",
    headers: authHeadersSchema,
    responses: {
      200: zeroOrgLogoResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Remove current organization logo",
  },
});

export type ZeroOrgLogoContract = typeof zeroOrgLogoContract;
