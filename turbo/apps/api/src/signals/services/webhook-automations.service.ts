import { randomBytes } from "node:crypto";

import { chatThreads } from "@vm0/db/schema/chat-thread";
import { eq } from "drizzle-orm";

import { internalApiBaseUrl } from "../../lib/internal-api-url";
import type { Db } from "../external/db";

/** Full inbound URL a signed payload is POSTed to for the given token. */
export function webhookUrlForToken(token: string): string {
  return `${internalApiBaseUrl()}/api/automations/webhooks/${token}`;
}

/**
 * Mint an unguessable URL token (identity) for a webhook trigger. The token is
 * stored in the clear for O(1) inbound lookup. 24 random bytes (192 bits)
 * render as a 48-char hex string; the `whk_` prefix keeps the whole token
 * within the trigger's varchar(64) webhook_token column.
 */
export function mintWebhookToken(): string {
  return `whk_${randomBytes(24).toString("hex")}`;
}

/**
 * Mint an HMAC signing secret (authentication) for a webhook trigger. The
 * secret is encrypted at rest and surfaced to the caller exactly once (at
 * creation or rotation).
 */
export function mintWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A chat thread may be linked to a webhook automation only if it exists, is
 * owned by the same user, and belongs to the same agent. (Chat threads carry
 * only a userId, so org isolation is enforced via the user — same rule the
 * automation surface applies.)
 */
export async function isChatThreadLinkable(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [thread] = await db
    .select({
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.chatThreadId))
    .limit(1);
  return (
    thread !== undefined &&
    thread.userId === args.userId &&
    thread.agentComposeId === args.agentId
  );
}
