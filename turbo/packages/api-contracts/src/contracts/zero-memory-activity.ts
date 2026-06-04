import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

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

const memoryActivityDiffSchema = z.object({
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
  /** Local day this summary covers, formatted YYYY-MM-DD. */
  date: z.string(),
  /** LLM narrative for the day; null when generation failed. */
  summary: z.string().nullable(),
  /** Version current at the start of the day; null for the first-ever summary. */
  fromVersionId: z.string().nullable(),
  /** Last version of the day. */
  toVersionId: z.string(),
  items: z.array(memoryActivityItemSchema),
});

/**
 * Precomputed daily Memory Activity timeline for the current user, ordered
 * most-recent-day first. Each entry is a per-local-day net summary with at
 * least one changed memory file and structured diff evidence — served as a
 * pure DB read.
 */
export const memoryActivityResponseSchema = z.object({
  entries: z.array(memoryActivityEntrySchema),
});

export type MemoryActivityResponse = z.infer<
  typeof memoryActivityResponseSchema
>;

/**
 * Zero memory activity contract for /api/zero/memory/activity
 *
 * GET: Read the current user's precomputed daily memory-change summaries.
 */
export const zeroMemoryActivityContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/memory/activity",
    headers: authHeadersSchema,
    responses: {
      200: memoryActivityResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get the current user's daily memory-change summaries",
  },
});

export type ZeroMemoryActivityContract = typeof zeroMemoryActivityContract;
