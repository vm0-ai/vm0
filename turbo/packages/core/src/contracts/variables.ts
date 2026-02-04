import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Variable name validation
 * Rules:
 * - 1-255 characters
 * - uppercase letters, numbers, and underscores only
 * - must start with a letter
 * Examples: MY_VAR, API_URL, DEBUG_MODE
 */
export const variableNameSchema = z
  .string()
  .min(1, "Variable name is required")
  .max(255, "Variable name must be at most 255 characters")
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    "Variable name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_VAR)",
  );

/**
 * Variable response (includes value - key difference from secrets)
 */
export const variableResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  value: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type VariableResponse = z.infer<typeof variableResponseSchema>;

/**
 * List variables response
 */
export const variableListResponseSchema = z.object({
  variables: z.array(variableResponseSchema),
});

export type VariableListResponse = z.infer<typeof variableListResponseSchema>;

/**
 * Set variable request (create or update)
 */
export const setVariableRequestSchema = z.object({
  name: variableNameSchema,
  value: z.string().min(1, "Variable value is required"),
  description: z.string().max(1000).optional(),
});

export type SetVariableRequest = z.infer<typeof setVariableRequestSchema>;

/**
 * Variables contract for /api/variables
 */
export const variablesMainContract = c.router({
  /**
   * GET /api/variables
   * List all variables for the current user's scope (includes values)
   */
  list: {
    method: "GET",
    path: "/api/variables",
    headers: authHeadersSchema,
    responses: {
      200: variableListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all variables (includes values)",
  },

  /**
   * PUT /api/variables
   * Create or update a variable
   */
  set: {
    method: "PUT",
    path: "/api/variables",
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

export type VariablesMainContract = typeof variablesMainContract;

/**
 * Variables by name contract for /api/variables/[name]
 */
export const variablesByNameContract = c.router({
  /**
   * GET /api/variables/:name
   * Get a variable by name (includes value)
   */
  get: {
    method: "GET",
    path: "/api/variables/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: variableNameSchema,
    }),
    responses: {
      200: variableResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get variable by name",
  },

  /**
   * DELETE /api/variables/:name
   * Delete a variable by name
   */
  delete: {
    method: "DELETE",
    path: "/api/variables/:name",
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
    summary: "Delete a variable",
  },
});

export type VariablesByNameContract = typeof variablesByNameContract;
