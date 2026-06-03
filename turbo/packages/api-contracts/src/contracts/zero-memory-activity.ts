import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const memoryActivityItemSchema = z.object({
  kind: z.enum(["learned", "updated", "forgotten"]),
  title: z.string().nullable(),
  description: z.string().nullable(),
  filePath: z.string(),
  beforeSnippet: z.string().nullable(),
  afterSnippet: z.string().nullable(),
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
 * most-recent-day first. Each entry is a per-local-day net summary of memory
 * changes with inline before/after evidence — served as a pure DB read.
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
