import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const identitySchema = z.object({
  orgId: z.string(),
  connectorId: z.string().uuid(),
});

const actionBodySchema = z.discriminatedUnion("action", [
  identitySchema.extend({ action: z.literal("read") }),
  identitySchema.extend({
    action: z.literal("claim"),
    versionId: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]);

const publicationSchema = z.object({
  versionId: z.string(),
  storageId: z.string().uuid(),
  s3Prefix: z.string(),
  state: z.enum(["preparing", "cleanup_claimed"]),
  stateUpdatedAt: z.string(),
});

const tombstoneSchema = z.object({
  storageId: z.string().uuid(),
  connectorId: z.string().uuid(),
  s3Prefix: z.string(),
  deletedAt: z.string(),
});

const actionResponseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    storage: z
      .object({ id: z.string().uuid(), s3Prefix: z.string() })
      .nullable(),
    publications: z.array(publicationSchema),
    tombstone: tombstoneSchema.nullable(),
  }),
  z.object({ action: z.literal("claim"), claimed: z.boolean() }),
]);

export const testCustomConnectorSkillCleanupStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/custom-connector-skill-cleanup-state",
    body: actionBodySchema,
    responses: { 200: actionResponseSchema },
    summary: "Read and claim Custom connector skill cleanup test state",
  },
});

export type TestCustomConnectorSkillCleanupStateAction = z.infer<
  typeof actionBodySchema
>;
export type TestCustomConnectorSkillCleanupStateResponse = z.infer<
  typeof actionResponseSchema
>;
