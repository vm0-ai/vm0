import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { env } from "../../lib/env";
import { safeJsonParse } from "../utils";

export const teamsFileTokenPayloadSchema = z.object({
  tenantId: z.string().min(1),
  url: z.string().url(),
  downloadMode: z.literal("graph").optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
});

export type TeamsFileTokenPayload = z.infer<typeof teamsFileTokenPayloadSchema>;

function signingSecret(): string {
  return env("SECRETS_ENCRYPTION_KEY");
}

function signatureFor(encodedPayload: string): string {
  return createHmac("sha256", signingSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function decodeTeamsFileToken(
  token: string,
): TeamsFileTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return null;
  }
  if (!constantTimeEqual(signature, signatureFor(encodedPayload))) {
    return null;
  }

  const payload = safeJsonParse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  const parsed = teamsFileTokenPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
