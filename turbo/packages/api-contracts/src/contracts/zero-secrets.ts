import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import {
  secretResponseSchema,
  secretListResponseSchema,
  secretNameSchema,
  setSecretRequestSchema,
} from "./secrets";
import {
  variableResponseSchema,
  variableListResponseSchema,
  variableNameSchema,
  setVariableRequestSchema,
} from "./variables";

const c = initContract();

/**
 * Zero secrets contract for /api/zero/secrets
 *
 * GET: List all secrets (metadata only)
 * POST: Create or update a secret (platform → infra proxy)
 */
export const zeroSecretsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/secrets",
    headers: authHeadersSchema,
    responses: {
      200: secretListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all secrets (metadata only)",
  },
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
 * Zero secrets by name contract for /api/zero/secrets/[name]
 *
 * DELETE: Delete a secret by name
 */
export const zeroSecretsByNameContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/secrets/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: secretNameSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a secret by name",
  },
});

export type ZeroSecretsByNameContract = typeof zeroSecretsByNameContract;

/**
 * Zero variables contract for /api/zero/variables
 *
 * GET: List all variables (includes values)
 * POST: Create or update a variable (platform → infra proxy)
 */
export const zeroVariablesContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/variables",
    headers: authHeadersSchema,
    responses: {
      200: variableListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all variables (includes values)",
  },
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

/**
 * Zero variables by name contract for /api/zero/variables/[name]
 *
 * DELETE: Delete a variable by name
 */
export const zeroVariablesByNameContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/variables/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: variableNameSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a variable by name",
  },
});

export type ZeroVariablesByNameContract = typeof zeroVariablesByNameContract;
