import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

// Test-only support actions that historically lived on the automations test
// route. The legacy automation seeding endpoints were removed with the
// automations tables (#20101); the remaining actions cover generic fixtures
// (composes, fake KMS, the vm0-managed default model key) still used by the
// API test suites.
export const testAutomationsStateErrorSchema = z.object({
  error: z.string(),
});

export const testAutomationsStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-compose"),
      org_id: z.string(),
      user_id: z.string(),
      compose_id: z.string().optional(),
    }),
    z.object({
      action: z.literal("read-compose-head-version"),
      compose_id: z.string(),
    }),
    z.object({
      action: z.literal("seed-vm0-managed-default-model-key"),
    }),
    z.object({
      action: z.literal("seed-vm0-managed-model-key"),
      selected_model: z.string(),
    }),
    z.object({
      action: z.literal("delete-vm0-managed-default-model-key"),
    }),
    z.object({
      action: z.literal("enable-fake-kms"),
    }),
    z.object({
      action: z.literal("reset-fake-kms"),
    }),
    z.object({
      action: z.literal("read-fake-kms-state"),
    }),
    z.object({
      action: z.literal("mutate-runner-job-secret-value-environment-keys"),
      run_id: z.uuid(),
      mode: z.enum(["remove", "invalid"]),
    }),
    z.object({
      action: z.literal("hold-org-admission-lock"),
      org_id: z.string(),
    }),
    z.object({
      action: z.literal("read-org-admission-lock-state"),
    }),
    z.object({
      action: z.literal("release-org-admission-lock"),
    }),
  ],
);

export const testAutomationsStateActionResponseSchema = z.object({
  ok: z.literal(true),
  compose_id: z.string().optional(),
  head_version_id: z.string().nullable().optional(),
  selected_model: z.string().optional(),
  decrypt_call_count: z.number().optional(),
  admission_lock_held: z.boolean().optional(),
  admission_lock_waiting: z.boolean().optional(),
});

export const testAutomationsStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/automations-state/action",
    body: testAutomationsStateActionBodySchema,
    responses: {
      200: testAutomationsStateActionResponseSchema,
      400: testAutomationsStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate API test support state",
  },
});

export type TestAutomationsStateContract = typeof testAutomationsStateContract;
export type TestAutomationsStateActionBody = z.infer<
  typeof testAutomationsStateActionBodySchema
>;
export type TestAutomationsStateActionResponse = z.infer<
  typeof testAutomationsStateActionResponseSchema
>;
