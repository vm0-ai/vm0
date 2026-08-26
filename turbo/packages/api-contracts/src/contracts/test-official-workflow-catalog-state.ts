import { z } from "zod";

import { initContract } from "./base";
import {
  officialWorkflowAcceptedDefinitionSchema,
  officialWorkflowAcceptedRevisionSchema,
  officialWorkflowCatalogReleasePayloadSchema,
} from "./official-workflow-catalog";
import { workflowNameSchema } from "./workflows";

const c = initContract();

export const testOfficialWorkflowCatalogStateActionBodySchema =
  z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("cleanup"),
      })
      .strict(),
    z
      .object({
        action: z.literal("read"),
        definitionName: workflowNameSchema.optional(),
        revision: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      })
      .strict()
      .refine(
        (value) => {
          return (
            value.revision === undefined || value.definitionName !== undefined
          );
        },
        { message: "definitionName is required with revision" },
      ),
  ]);
export type TestOfficialWorkflowCatalogStateActionBody = z.infer<
  typeof testOfficialWorkflowCatalogStateActionBodySchema
>;

const testOfficialWorkflowCatalogStorageStateSchema = z
  .object({
    storageName: z.string(),
    storageId: z.string().uuid(),
    orgId: z.string(),
    userId: z.string(),
    headVersionId: z.string().nullable(),
    versionCount: z.number().int().nonnegative(),
  })
  .strict();

export const testOfficialWorkflowCatalogStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
    catalog: z
      .object({
        releaseId: z.string().regex(/^[0-9a-f]{64}$/),
        payload: officialWorkflowCatalogReleasePayloadSchema,
      })
      .strict()
      .nullable(),
    definition: officialWorkflowAcceptedDefinitionSchema.nullable(),
    revision: officialWorkflowAcceptedRevisionSchema.nullable(),
    storage: testOfficialWorkflowCatalogStorageStateSchema.nullable(),
    counts: z
      .object({
        releases: z.number().int().nonnegative(),
        revisions: z.number().int().nonnegative(),
        storages: z.number().int().nonnegative(),
        storageVersions: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type TestOfficialWorkflowCatalogStateActionResponse = z.infer<
  typeof testOfficialWorkflowCatalogStateActionResponseSchema
>;

export const testOfficialWorkflowCatalogStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/official-workflow-catalog-state/action",
    body: testOfficialWorkflowCatalogStateActionBodySchema,
    responses: {
      200: testOfficialWorkflowCatalogStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Inspect and clean Official Workflow catalog API test state",
  },
});

export type TestOfficialWorkflowCatalogStateContract =
  typeof testOfficialWorkflowCatalogStateContract;
