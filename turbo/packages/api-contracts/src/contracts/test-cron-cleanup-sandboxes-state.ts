import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testCronCleanupSandboxesStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-run",
      "delete-run",
      "seed-runner-job",
      "seed-queue-entry",
      "seed-queue-marker",
      "seed-export-job",
      "delete-export-job",
      "get-run",
      "get-runner-job",
      "get-queue-entry",
      "get-queue-marker-revoker",
      "get-export-job",
    ]),
  })
  .passthrough();

export const testCronCleanupSandboxesStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testCronCleanupSandboxesStateErrorSchema = z.object({
  error: z.string(),
});

export const testCronCleanupSandboxesStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-cleanup-sandboxes-state/action",
    body: testCronCleanupSandboxesStateActionBodySchema,
    responses: {
      200: testCronCleanupSandboxesStateActionResponseSchema,
      400: testCronCleanupSandboxesStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate or inspect cron cleanup sandboxes test state",
  },
});

export type TestCronCleanupSandboxesStateActionBody = z.infer<
  typeof testCronCleanupSandboxesStateActionBodySchema
>;
export type TestCronCleanupSandboxesStateActionResponse = z.infer<
  typeof testCronCleanupSandboxesStateActionResponseSchema
>;
export type TestCronCleanupSandboxesStateContract =
  typeof testCronCleanupSandboxesStateContract;
