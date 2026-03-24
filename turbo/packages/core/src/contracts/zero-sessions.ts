import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { storedChatMessageSchema } from "./sessions";

const c = initContract();

/**
 * Zero session response schema — uses `agentId` instead of `agentComposeId`.
 */
const zeroSessionResponseSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  conversationId: z.string().nullable(),
  artifactName: z.string().nullable(),
  secretNames: z.array(z.string()).nullable(),
  chatMessages: z.array(storedChatMessageSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

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
      200: zeroSessionResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get session by ID (zero proxy)",
  },
});

export type ZeroSessionsByIdContract = typeof zeroSessionsByIdContract;
