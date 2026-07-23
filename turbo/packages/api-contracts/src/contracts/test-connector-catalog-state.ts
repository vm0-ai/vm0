import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testConnectorCatalogStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-legacy-active"),
      catalog_version: z.string().min(1),
      catalog_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      activated_at: z.iso.datetime(),
    }),
    z.object({
      action: z.literal("delete"),
      source_id: z.string().min(1),
    }),
  ],
);

export const testConnectorCatalogStateActionResponseSchema = z.object({
  ok: z.literal(true),
  source_id: z.string().min(1),
});

export const testConnectorCatalogStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/connector-catalog-state/action",
    body: testConnectorCatalogStateActionBodySchema,
    responses: {
      200: testConnectorCatalogStateActionResponseSchema,
      404: z.string(),
    },
    summary: "Mutate connector catalog API test state",
  },
});

export type TestConnectorCatalogStateActionBody = z.infer<
  typeof testConnectorCatalogStateActionBodySchema
>;
