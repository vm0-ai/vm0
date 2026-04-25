import { z } from "zod";

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
  id: z.uuid(),
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
