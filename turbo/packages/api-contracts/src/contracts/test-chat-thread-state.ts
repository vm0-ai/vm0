import { z } from "zod";

import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
} from "./model-providers";
import { initContract } from "./base";

const c = initContract();

export const testChatThreadStateContract = c.router({
  setLegacyModelState: {
    method: "POST",
    path: "/api/test/chat-thread-state/legacy-model",
    body: z.object({
      threadId: z.string(),
      userId: z.string(),
      modelProviderId: z.string().nullable(),
      modelProviderType: modelProviderTypeSchema.nullable(),
      modelProviderCredentialScope:
        modelProviderCredentialScopeSchema.nullable(),
      selectedModel: z.string().nullable(),
      codexServiceTier: z.enum(["fast"]).nullable(),
    }),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      404: z.object({ error: z.string() }),
    },
    summary: "Set legacy persisted chat-thread model state for API tests",
  },
});
