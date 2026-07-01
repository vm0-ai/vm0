import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testChatMessagesStateErrorSchema = z.object({
  error: z.string(),
});

export const VM0_BDD_API_KEY_PREFIXES = [
  "vm0-key-bdd-fake-",
  "vm0-key-bdd-dev-seed-",
] as const;

const vm0BddApiKeySchema = z.string().refine(
  (apiKey) => {
    return VM0_BDD_API_KEY_PREFIXES.some((prefix) => {
      return apiKey.length > prefix.length && apiKey.startsWith(prefix);
    });
  },
  { message: "Expected a bdd-scoped vm0 API key" },
);

const vm0ApiKeySeedSchema = z.object({
  api_key: vm0BddApiKeySchema,
  label: z.string(),
});

const vm0ApiKeyVendorSchema = z.enum([
  "anthropic",
  "deepseek",
  "minimax",
  "moonshot",
  "openai",
  "openrouter",
]);

export const testChatMessagesStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("overwrite-org-model-provider-secret"),
      org_id: z.string(),
      name: z.string(),
      value: z.string(),
    }),
    z.object({
      action: z.literal("read-thread-computer-use-host-id"),
      thread_id: z.string(),
    }),
    z.object({
      action: z.literal("read-run-model-metadata"),
      run_id: z.uuid(),
    }),
    z.object({
      action: z.literal("insert-errored-unassociated-user-message"),
      thread_id: z.uuid(),
      content: z.string(),
      error: z.string(),
    }),
    z.object({
      action: z.literal("replace-openrouter-vm0-api-keys"),
      model: z.string(),
      keys: z.array(vm0ApiKeySeedSchema),
    }),
    z.object({
      action: z.literal("delete-openrouter-vm0-api-keys"),
      model: z.string(),
    }),
    z.object({
      action: z.literal("replace-vm0-api-keys"),
      vendor: vm0ApiKeyVendorSchema,
      model: z.string(),
      keys: z.array(vm0ApiKeySeedSchema),
    }),
    z.object({
      action: z.literal("delete-vm0-api-keys"),
      vendor: vm0ApiKeyVendorSchema,
      model: z.string(),
    }),
    z.object({
      action: z.literal("attach-pre-dispatch-cancelled-run-to-thread"),
      run_id: z.uuid(),
      thread_id: z.uuid(),
    }),
  ],
);

export const testChatMessagesStateActionResponseSchema = z.object({
  ok: z.literal(true),
  computer_use_host_id: z.string().nullable().optional(),
  run_model_provider: z.string().nullable().optional(),
  run_model_provider_credential_scope: z
    .enum(["org", "member"])
    .nullable()
    .optional(),
  run_selected_model: z.string().nullable().optional(),
  message_id: z.uuid().optional(),
});

export const testChatMessagesStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/chat-messages-state/action",
    body: testChatMessagesStateActionBodySchema,
    responses: {
      200: testChatMessagesStateActionResponseSchema,
      400: testChatMessagesStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read chat messages API test support state",
  },
});

export type TestChatMessagesStateContract =
  typeof testChatMessagesStateContract;
export type TestChatMessagesStateActionBody = z.infer<
  typeof testChatMessagesStateActionBodySchema
>;
export type TestChatMessagesStateActionResponse = z.infer<
  typeof testChatMessagesStateActionResponseSchema
>;
