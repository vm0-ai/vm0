import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  draftVoiceSchema,
  persistedAttachmentSchema,
  userMessageInputDocumentSchema,
} from "./chat-threads";
import { requireUserMessageForDraftAttachments } from "./draft-user-message";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const agentDraftResponseSchema = z
  .object({
    draftUserMessage: userMessageInputDocumentSchema.nullable(),
    // New App clients may receive responses from a pre-#31562 API while it is
    // serving or retained for rollback. Remove with #31612 after that window.
    draftVoice: draftVoiceSchema.nullable().optional(),
    draftAttachments: z.array(persistedAttachmentSchema).nullable(),
  })
  .superRefine(requireUserMessageForDraftAttachments);

export const agentDraftRequestSchema = z
  .object({
    draftUserMessage: userMessageInputDocumentSchema.nullable(),
    // Pre-#31562 App clients may omit this for about two days. Remove the
    // optional bridge with #31612 once the client-version floor excludes them.
    draftVoice: draftVoiceSchema.nullable().optional(),
    draftAttachments: z.array(persistedAttachmentSchema).nullable().optional(),
  })
  .superRefine(requireUserMessageForDraftAttachments);

export const agentDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: agentDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent draft",
  },
  patch: {
    method: "PATCH",
    path: "/api/agents/:id/draft",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: agentDraftRequestSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update agent draft",
  },
});

export type AgentDraftResponse = z.infer<typeof agentDraftResponseSchema>;
export type AgentDraftRequest = z.infer<typeof agentDraftRequestSchema>;
export type AgentDraftContract = typeof agentDraftContract;
