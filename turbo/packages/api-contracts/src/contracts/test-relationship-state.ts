import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testRelationshipStateErrorSchema = z.object({
  error: z.string(),
});

export const testRelationshipStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
});

export const testRelationshipStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("delete-relationships"),
      fixture: testRelationshipStateFixtureSchema,
    }),
    z.object({
      action: z.literal("seed-relationships"),
      fixture: testRelationshipStateFixtureSchema,
      count: z.number().int().min(0).max(500),
    }),
    z.object({
      action: z.literal("seed-runtime-injection-memories"),
      fixture: testRelationshipStateFixtureSchema,
    }),
  ],
);

export const testRelationshipStateActionResponseSchema = z.object({
  ok: z.literal(true),
});

export const testRelationshipStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/relationship-state/action",
    body: testRelationshipStateActionBodySchema,
    responses: {
      200: testRelationshipStateActionResponseSchema,
      400: testRelationshipStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate relationship memory API test support state",
  },
});

export type TestRelationshipStateContract =
  typeof testRelationshipStateContract;
export type TestRelationshipStateFixture = z.infer<
  typeof testRelationshipStateFixtureSchema
>;
export type TestRelationshipStateActionBody = z.infer<
  typeof testRelationshipStateActionBodySchema
>;
export type TestRelationshipStateActionResponse = z.infer<
  typeof testRelationshipStateActionResponseSchema
>;
