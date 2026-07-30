import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { createRunResponseSchema, unifiedRunRequestSchema } from "./runs";

const c = initContract();

export const testAgentRunsContract = c.router({
  create: {
    method: "POST",
    path: "/api/test/agent-runs",
    headers: authHeadersSchema,
    body: unifiedRunRequestSchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: z.union([apiErrorSchema, z.string()]),
      429: apiErrorSchema,
      422: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create an agent run for end-to-end tests",
  },
});

export type TestAgentRunsContract = typeof testAgentRunsContract;
