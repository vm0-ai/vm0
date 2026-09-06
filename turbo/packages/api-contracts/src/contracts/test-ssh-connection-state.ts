import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testSshConnectionStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("set-learned-host-key"),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        connectionId: z.uuid(),
        algorithm: z.string().min(1).max(64),
        fingerprint: z.string().min(1).max(64),
      })
      .strict(),
    z
      .object({
        action: z.literal("match-credentials"),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        connectionId: z.uuid(),
        privateKey: z.string(),
        passphrase: z.string().nullable(),
      })
      .strict(),
  ],
);

export const testSshConnectionStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
    generation: z.int().positive().optional(),
    privateKeyMatches: z.boolean().optional(),
    passphraseMatches: z.boolean().optional(),
  })
  .strict();

export const testSshConnectionStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/ssh-connection-state/action",
    body: testSshConnectionStateActionBodySchema,
    responses: {
      200: testSshConnectionStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Mutate and inspect SSH connection state for API tests",
  },
});

export type TestSshConnectionStateActionBody = z.infer<
  typeof testSshConnectionStateActionBodySchema
>;
