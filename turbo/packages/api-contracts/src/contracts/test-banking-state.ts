import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testBankingStateErrorSchema = z.object({
  error: z.string(),
});

const auditEventSchema = z.object({
  action: z.string(),
  status: z.string(),
  failure_code: z.string().nullable(),
  provider_account_id: z.string().nullable(),
});

export const testBankingStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-fixture"),
    org_id: z.string(),
    user_id: z.string(),
    agent_id: z.string(),
    provider_customer_id: z.string(),
    enabled_account_id: z.string(),
    disabled_account_id: z.string(),
    operation_scopes: z.array(z.string()),
    account_provider_ids: z.array(z.string()),
    allow_automation_runs: z.boolean(),
    connection_status: z.string(),
  }),
  z.object({
    action: z.literal("delete-fixture"),
    org_id: z.string(),
    user_id: z.string(),
  }),
  z.object({
    action: z.literal("read-audit-events"),
    org_id: z.string(),
    user_id: z.string(),
  }),
]);

export const testBankingStateActionResponseSchema = z.object({
  ok: z.literal(true),
  connection_id: z.string().optional(),
  audit_events: z.array(auditEventSchema).optional(),
});

export const testBankingStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/banking-state/action",
    body: testBankingStateActionBodySchema,
    responses: {
      200: testBankingStateActionResponseSchema,
      400: testBankingStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read Zero Banking API test support state",
  },
});

export type TestBankingStateContract = typeof testBankingStateContract;
export type TestBankingStateActionBody = z.infer<
  typeof testBankingStateActionBodySchema
>;
export type TestBankingStateActionResponse = z.infer<
  typeof testBankingStateActionResponseSchema
>;
export type TestBankingStateAuditEvent = z.infer<typeof auditEventSchema>;
