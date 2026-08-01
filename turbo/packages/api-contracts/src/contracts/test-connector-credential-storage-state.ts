import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const connectorStateSchema = z.object({
  id: z.uuid(),
  storage_version: z.number().int().positive(),
});

const secretStateSchema = z.object({
  name: z.string(),
  connector_id: z.uuid(),
  encrypted_value: z.string(),
  description: z.string().nullable(),
});

const variableStateSchema = z.object({
  name: z.string(),
  connector_id: z.uuid(),
});

export const testConnectorCredentialStorageStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("read"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      secret_names: z.array(z.string()),
      variable_names: z.array(z.string()),
    }),
    z.object({
      action: z.literal("seed-owned-secret"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      auth_method: z.string(),
      storage_version: z.number().int().positive(),
      name: z.string(),
      encrypted_value: z.string(),
      description: z.string().nullable(),
    }),
    z.object({
      action: z.literal("seed-connector"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      auth_method: z.string(),
      storage_version: z.number().int().positive(),
    }),
    z.object({
      action: z.literal("set-connector-state"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      storage_version: z.number().int().positive(),
      token_expires_at: z.iso.datetime().nullable().optional(),
    }),
    z.object({
      action: z.literal("set-secret-owner"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("set-variable-owner"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      connector_id: z.uuid(),
    }),
  ]);

export const testConnectorCredentialStorageStateActionResponseSchema = z.object(
  {
    ok: z.literal(true),
    connector: connectorStateSchema.nullable().optional(),
    connector_id: z.uuid().optional(),
    secrets: z.array(secretStateSchema).optional(),
    variables: z.array(variableStateSchema).optional(),
  },
);

export const testConnectorCredentialStorageStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/connector-credential-storage-state/action",
    body: testConnectorCredentialStorageStateActionBodySchema,
    responses: {
      200: testConnectorCredentialStorageStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Mutate and read connector credential storage API test state",
  },
});

export type TestConnectorCredentialStorageStateActionBody = z.infer<
  typeof testConnectorCredentialStorageStateActionBodySchema
>;
export type TestConnectorCredentialStorageStateActionResponse = z.infer<
  typeof testConnectorCredentialStorageStateActionResponseSchema
>;
