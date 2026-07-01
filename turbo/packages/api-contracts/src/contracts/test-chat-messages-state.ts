import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testChatMessagesStateErrorSchema = z.object({
  error: z.string(),
});

const vm0ApiKeySeedSchema = z.object({
  api_key: z.string(),
  label: z.string(),
});

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
      vendor: z.string(),
      model: z.string(),
      keys: z.array(vm0ApiKeySeedSchema),
    }),
    z.object({
      action: z.literal("delete-vm0-api-keys"),
      vendor: z.string(),
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
