import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sessionResponseSchema } from "./sessions";

const c = initContract();

/**
 * Zero sessions proxy contract.
 * GET /api/zero/sessions/:id → forwards to GET /api/agent/sessions/:id
 */
export const zeroSessionsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/sessions/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Session ID is required"),
    }),
    responses: {
      200: sessionResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get session by ID (zero proxy)",
  },
});

export type ZeroSessionsByIdContract = typeof zeroSessionsByIdContract;
