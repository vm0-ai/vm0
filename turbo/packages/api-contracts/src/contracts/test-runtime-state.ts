import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

// Test-only support actions for infrastructure fixtures used by API suites.
export const testRuntimeStateErrorSchema = z.object({
  error: z.string(),
});

export const testRuntimeStateActionBodySchema = z.discriminatedUnion("action", [
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
    action: z.literal("mutate-runner-job-connector-permission-baseline"),
    run_id: z.uuid(),
    mode: z.enum([
      "remove",
      "malformed",
      "capability-mismatch",
      "catalog-mismatch",
      "authority-mismatch",
      "inconsistent",
      "incomplete",
    ]),
  }),
  z.object({
    action: z.literal("remove-run-canonical-storage-state"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-runner-job-storage-state"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-storage-persistence-state"),
    run_id: z.uuid(),
    session_id: z.uuid(),
    checkpoint_id: z.uuid(),
  }),
  z.object({
    action: z.literal("replace-custom-connector-prefixes"),
    connector_id: z.uuid(),
    prefixes: z.array(z.string()).min(1),
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
  z.object({
    action: z.literal("read-run-uploaded-file-sources"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("clear-run-api-start"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-run-api-start"),
    run_id: z.uuid(),
  }),
  z.object({
    action: z.literal("read-thread-session-binding"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("clear-thread-session-binding"),
    thread_id: z.uuid(),
  }),
  z.object({
    action: z.literal("insert-legacy-artifact-catalog-file"),
    user_id: z.string(),
    org_id: z.string(),
    filename: z.string(),
    url: z.url(),
  }),
  z.object({
    action: z.literal("insert-hosted-site-as-previous-api"),
    user_id: z.string(),
    org_id: z.string(),
    run_id: z.uuid(),
    site: z.string(),
    public_slug: z.string(),
  }),
  z.object({
    action: z.literal("insert-hosted-deployment-as-previous-api"),
    user_id: z.string(),
    org_id: z.string(),
    run_id: z.uuid(),
    hosted_site_id: z.uuid(),
  }),
  z.object({
    action: z.literal("set-computer-use-host-as-previous-api"),
    thread_id: z.uuid(),
    computer_use_host_id: z.uuid(),
  }),
  z.object({
    action: z.literal("set-browser-tab-snapshot-as-previous-api"),
    thread_id: z.uuid(),
    tab_urls: z.array(z.string().max(8192)).max(50),
  }),
  z.object({
    action: z.literal("set-runner-job-context-profile-as-previous-api"),
    run_id: z.uuid(),
    profile: z.string(),
  }),
]);

export const testRuntimeStateActionResponseSchema = z.object({
  ok: z.literal(true),
  selected_model: z.string().optional(),
  decrypt_call_count: z.number().optional(),
  admission_lock_held: z.boolean().optional(),
  admission_lock_waiting: z.boolean().optional(),
  uploaded_file_sources: z.array(z.string()).optional(),
  api_started_at: z.string().nullable().optional(),
  thread_session_binding: z
    .object({
      agent_session_id: z.uuid().nullable(),
      agent_session_run_id: z.uuid().nullable(),
      run_session_id: z.uuid().nullable(),
    })
    .optional(),
  file_id: z.uuid().optional(),
  hosted_site_id: z.uuid().optional(),
  hosted_deployment_scope_blocked: z.boolean().optional(),
  storage_persistence: z
    .object({
      run_canonical: z.boolean(),
      session_canonical: z.boolean(),
      checkpoint_canonical: z.boolean(),
    })
    .optional(),
  runner_job_storage_state: z
    .object({
      has_stored_storage_manifest: z.boolean(),
      canonical_mount_count: z.number().int().nonnegative(),
      has_run_context_storage: z.boolean(),
    })
    .optional(),
});

export const testRuntimeStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/runtime-state/action",
    body: testRuntimeStateActionBodySchema,
    responses: {
      200: testRuntimeStateActionResponseSchema,
      400: testRuntimeStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate API test support state",
  },
});

export type TestRuntimeStateContract = typeof testRuntimeStateContract;
export type TestRuntimeStateActionBody = z.infer<
  typeof testRuntimeStateActionBodySchema
>;
export type TestRuntimeStateActionResponse = z.infer<
  typeof testRuntimeStateActionResponseSchema
>;
