import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MEMORY_ACTIVITY_DEFAULT_LIMIT = 20;
export const MEMORY_ACTIVITY_MAX_LIMIT = 50;

const memoryActivityDiffLineSchema = z.object({
  op: z.enum(["context", "add", "remove"]),
  beforeLine: z.number().int().positive().nullable(),
  afterLine: z.number().int().positive().nullable(),
  text: z.string(),
});

const memoryActivityDiffHunkSchema = z.object({
  beforeStartLine: z.number().int().positive().nullable(),
  afterStartLine: z.number().int().positive().nullable(),
  lines: z.array(memoryActivityDiffLineSchema),
});

export const memoryActivityDiffSchema = z.object({
  format: z.literal("line"),
  beforeExists: z.boolean(),
  afterExists: z.boolean(),
  truncated: z.boolean(),
  stats: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  hunks: z.array(memoryActivityDiffHunkSchema),
  omittedReason: z.enum(["too_large", "binary", "unsupported"]).optional(),
});

const memoryActivityItemSchema = z.object({
  filePath: z.string(),
  diff: memoryActivityDiffSchema,
});

const memoryActivityEntrySchema = z.object({
  date: z.string(),
  summary: z.string().nullable(),
  fromVersionId: z.string().nullable(),
  toVersionId: z.string(),
  items: z.array(memoryActivityItemSchema),
});

export const memoryActivityResponseSchema = z.object({
  entries: z.array(memoryActivityEntrySchema),
  nextCursor: z.string().nullable(),
});

export type MemoryActivityResponse = z.infer<
  typeof memoryActivityResponseSchema
>;

/**
 * Temporary response contract for browser clients that loaded the retired
 * Memory page before its frontend deployment. Remove after those clients have
 * drained.
 */
export const zeroMemoryActivityContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/memory/activity",
    headers: authHeadersSchema,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MEMORY_ACTIVITY_MAX_LIMIT)
        .default(MEMORY_ACTIVITY_DEFAULT_LIMIT),
      cursor: z.string().min(1).optional(),
    }),
    responses: {
      200: memoryActivityResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Return an empty response for retired memory activity clients",
  },
});

export type ZeroMemoryActivityContract = typeof zeroMemoryActivityContract;
