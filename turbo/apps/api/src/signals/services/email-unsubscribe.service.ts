import { timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { users } from "@vm0/db/schema/user";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";

const SIGNATURE_HEX_LENGTH = 32;
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PAYLOAD_PREFIX = "unsubscribe:";

async function createUnsubscribeTokenSignature(
  userId: string,
): Promise<string> {
  const textEncoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(env("SECRETS_ENCRYPTION_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${TOKEN_PAYLOAD_PREFIX}${userId}`),
  );

  return Buffer.from(signature).toString("hex").slice(0, SIGNATURE_HEX_LENGTH);
}

export async function verifyUnsubscribeToken(
  token: string,
): Promise<string | null> {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const userId = token.slice(0, dotIndex);
  const providedHmac = token.slice(dotIndex + 1);

  if (!userId || !providedHmac) {
    return null;
  }

  const expectedHmac = await createUnsubscribeTokenSignature(userId);
  if (!SIGNATURE_HEX_PATTERN.test(providedHmac)) {
    return null;
  }

  const isValid = timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac),
  );

  return isValid ? userId : null;
}

export const unsubscribeEmailUser$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    await set(writeDb$)
      .insert(users)
      .values({ id: userId, emailUnsubscribed: true })
      .onConflictDoUpdate({
        target: users.id,
        set: { emailUnsubscribed: true, updatedAt: nowDate() },
      });
    signal.throwIfAborted();
  },
);
