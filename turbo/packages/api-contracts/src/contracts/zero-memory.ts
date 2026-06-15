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

/**
 * Read-only view of the current user's "memory" artifact (latest version).
 *
 * `exists` is false when the user has never produced memory (no artifact yet);
 * in that case the lists are empty and `updatedAt` is null.
 */
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
 * Zero memory contract for /api/zero/memory
 *
 * GET: Read the current user's memory artifact contents (latest version).
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
    summary: "Get the current user's memory artifact contents",
  },
});

export type ZeroMemoryContract = typeof zeroMemoryContract;
