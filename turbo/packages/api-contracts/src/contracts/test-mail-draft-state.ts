import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testMailDraftStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("create-previous-version-draft"),
      mailDraftId: z.uuid(),
      threadId: z.uuid(),
    }),
  ],
);

const testMailDraftStateActionResponseSchema = z.object({
  ok: z.literal(true),
});

const testMailDraftStateErrorSchema = z.object({
  error: z.string(),
});

export const testMailDraftStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/mail-draft-state/action",
    body: testMailDraftStateActionBodySchema,
    responses: {
      200: testMailDraftStateActionResponseSchema,
      400: testMailDraftStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate mail draft API test support state",
  },
  get: {
    method: "GET",
    path: "/api/test/mail-draft-state/:mailDraftId",
    pathParams: z.object({ mailDraftId: z.uuid() }),
    responses: {
      200: z.object({ exists: z.boolean() }),
      404: z.string(),
    },
    summary: "Inspect mail draft API test support state",
  },
});

export type TestMailDraftStateContract = typeof testMailDraftStateContract;
export type TestMailDraftStateActionBody = z.infer<
  typeof testMailDraftStateActionBodySchema
>;
