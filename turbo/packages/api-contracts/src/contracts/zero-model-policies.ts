import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  orgModelPoliciesResponseSchema,
  updateOrgModelPoliciesRequestSchema,
} from "./model-providers";

const c = initContract();

export const zeroModelPoliciesMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/model-policies",
    headers: authHeadersSchema,
    responses: {
      200: orgModelPoliciesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org model-first policies",
  },
  update: {
    method: "PUT",
    path: "/api/zero/model-policies",
    headers: authHeadersSchema,
    body: updateOrgModelPoliciesRequestSchema,
    responses: {
      200: orgModelPoliciesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update org model-first policies",
  },
});

export type ZeroModelPoliciesMainContract =
  typeof zeroModelPoliciesMainContract;
