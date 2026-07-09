import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testArtifactPreviewStateErrorSchema = z.object({
  error: z.string(),
});

export const testArtifactPreviewStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("mark-preview-cron-eligible"),
      run_id: z.string(),
      url: z.string(),
    }),
  ],
);

export const testArtifactPreviewStateActionResponseSchema = z.object({
  ok: z.literal(true),
  updated: z.number().optional(),
});

export const testArtifactPreviewStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/artifact-preview-state/action",
    body: testArtifactPreviewStateActionBodySchema,
    responses: {
      200: testArtifactPreviewStateActionResponseSchema,
      400: testArtifactPreviewStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate artifact preview API test support state",
  },
});

export type TestArtifactPreviewStateActionBody = z.infer<
  typeof testArtifactPreviewStateActionBodySchema
>;
export type TestArtifactPreviewStateActionResponse = z.infer<
  typeof testArtifactPreviewStateActionResponseSchema
>;
export type TestArtifactPreviewStateContract =
  typeof testArtifactPreviewStateContract;
