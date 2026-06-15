import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const developerSupportBodySchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  consentCode: z.string().optional(),
});

const consentCodeResponseSchema = z.object({
  consentCode: z.string(),
});

const submitResponseSchema = z.object({
  reference: z.string(),
});

export const zeroDeveloperSupportContract = c.router({
  submit: {
    method: "POST",
    path: "/api/zero/developer-support",
    headers: authHeadersSchema,
    body: developerSupportBodySchema,
    responses: {
      200: z.union([consentCodeResponseSchema, submitResponseSchema]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Developer support: consent code generation or diagnostic submission",
  },
});

export type ZeroDeveloperSupportContract = typeof zeroDeveloperSupportContract;
export {
  developerSupportBodySchema,
  consentCodeResponseSchema,
  submitResponseSchema,
};
