import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testMailDraftStateContract = c.router({
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
