import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Agent required environment schema
 */
const agentRequiredEnvSchema = z.object({
  composeId: z.string(),
  agentName: z.string(),
  requiredSecrets: z.array(z.string()),
  requiredVariables: z.array(z.string()),
});

/**
 * Required env route contract (/api/agent/required-env)
 * Returns all required secrets and variables for each of the user's agents
 */
export const requiredEnvContract = c.router({
  /**
   * GET /api/agent/required-env
   * Get required environment variables for user agents
   */
  getRequiredEnv: {
    method: "GET",
    path: "/api/agent/required-env",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ agents: z.array(agentRequiredEnvSchema) }),
      401: apiErrorSchema,
    },
    summary: "Get required environment variables for user agents",
  },
});

// Type exports
export type RequiredEnvContract = typeof requiredEnvContract;

// Schema exports
export { agentRequiredEnvSchema };
