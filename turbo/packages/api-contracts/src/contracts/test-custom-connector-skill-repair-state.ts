import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const actionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    connectorId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("set-connector"),
    connectorId: z.string().uuid(),
    skillMarkdown: z.string().nullable().optional(),
    skillStorageVersionId: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal("set-head"),
    connectorId: z.string().uuid(),
    headVersionId: z.string().nullable(),
  }),
  z.object({
    action: z.literal("set-provider-adapter"),
    connectorId: z.string().uuid(),
    providerAdapter: z.enum(["standard", "feishu"]),
  }),
  z.object({
    action: z.literal("set-managed-feishu-installation"),
    connectorId: z.string().uuid(),
    installationId: z.string().uuid(),
    defaultComposeId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("clear-managed-feishu-installation"),
    connectorId: z.string().uuid(),
    installationId: z.string().uuid(),
  }),
]);

const stateSchema = z.object({
  connector: z.object({
    skillMarkdown: z.string().nullable(),
    skillStorageVersionId: z.string().nullable(),
    oauthProviderAdapter: z.enum(["standard", "feishu"]).nullable(),
    managedFeishuInstallationId: z.string().uuid().nullable(),
  }),
  storage: z
    .object({
      id: z.string().uuid(),
      headVersionId: z.string().nullable(),
    })
    .nullable(),
});

const actionResponseSchema = z.object({
  ok: z.literal(true),
  state: stateSchema,
});

export const testCustomConnectorSkillRepairStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/custom-connector-skill-repair-state/action",
    body: actionBodySchema,
    responses: {
      200: actionResponseSchema,
      404: apiErrorSchema,
    },
    summary: "Mutate custom connector skill repair test state",
  },
});
