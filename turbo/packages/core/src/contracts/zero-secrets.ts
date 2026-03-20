import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { secretResponseSchema, setSecretRequestSchema } from "./secrets";
import { variableResponseSchema, setVariableRequestSchema } from "./variables";

const c = initContract();

/**
 * Zero secrets contract for /api/zero/secrets
 *
 * POST: Create or update a secret (platform → infra proxy)
 */
export const zeroSecretsContract = c.router({
  set: {
    method: "POST",
    path: "/api/zero/secrets",
    headers: authHeadersSchema,
    body: setSecretRequestSchema,
    responses: {
      200: secretResponseSchema,
      201: secretResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update a secret",
  },
});

export type ZeroSecretsContract = typeof zeroSecretsContract;

/**
 * Zero variables contract for /api/zero/variables
 *
 * POST: Create or update a variable (platform → infra proxy)
 */
export const zeroVariablesContract = c.router({
  set: {
    method: "POST",
    path: "/api/zero/variables",
    headers: authHeadersSchema,
    body: setVariableRequestSchema,
    responses: {
      200: variableResponseSchema,
      201: variableResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update a variable",
  },
});

export type ZeroVariablesContract = typeof zeroVariablesContract;
