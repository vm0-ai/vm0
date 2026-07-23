import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const memoryFileSchema = z.object({
  path: z.string(),
  size: z.number(),
});

const memoryFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const memoryDetailResponseSchema = z.object({
  exists: z.boolean(),
  name: z.string(),
  size: z.number(),
  fileCount: z.number(),
  updatedAt: z.string().nullable(),
  files: z.array(memoryFileSchema),
  fileContents: z.array(memoryFileContentSchema),
});

export type MemoryDetailResponse = z.infer<typeof memoryDetailResponseSchema>;

/**
 * Temporary response contract for browser clients that loaded the retired
 * Memory page before its frontend deployment. Remove after those clients have
 * drained.
 */
export const zeroMemoryContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/memory",
    headers: authHeadersSchema,
    responses: {
      200: memoryDetailResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Return an empty response for retired memory viewer clients",
  },
});

export type ZeroMemoryContract = typeof zeroMemoryContract;
