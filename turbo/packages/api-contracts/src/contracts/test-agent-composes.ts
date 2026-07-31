import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import {
  agentComposeApiContentSchema,
  composeResponseSchema,
  createComposeResponseSchema,
} from "./composes";
import { apiErrorSchema } from "./errors";

const c = initContract();

const testEndpointNotFoundSchema = z.union([apiErrorSchema, z.string()]);

export const testAgentComposesContract = c.router({
  getByName: {
    method: "GET",
    path: "/api/test/agent-composes",
    headers: authHeadersSchema,
    query: z.object({
      name: z.string().min(1, "Missing name query parameter"),
    }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: testEndpointNotFoundSchema,
    },
    summary: "Get an agent compose by name for end-to-end tests",
  },
  create: {
    method: "POST",
    path: "/api/test/agent-composes",
    headers: authHeadersSchema,
    body: z.object({
      content: agentComposeApiContentSchema,
    }),
    responses: {
      200: createComposeResponseSchema,
      201: createComposeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: testEndpointNotFoundSchema,
    },
    summary: "Create or update an agent compose for end-to-end tests",
  },
});

export type TestAgentComposesContract = typeof testAgentComposesContract;
