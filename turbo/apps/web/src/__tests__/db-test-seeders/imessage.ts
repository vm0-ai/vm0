import { initServices } from "../../lib/init-services";
import { imessageMessages } from "@vm0/db/schema/imessage-message";
import { imessageThreadSessions } from "@vm0/db/schema/imessage-thread-session";
import { imessageUserAgentPreferences } from "@vm0/db/schema/imessage-user-agent-preference";
import { imessageUserLinks } from "@vm0/db/schema/imessage-user-link";
import { signIMessageConnectParams } from "../../lib/zero/imessage/connect-token";
import { normalizePhoneHandle } from "../../lib/zero/imessage/shared";

/**
 * @why-db-direct Creates official shared iMessage user link rows for inbound
 * webhook and callback tests; no public test API exists for this provider state.
 */
export async function insertTestIMessageUserLink(params: {
  phoneHandle: string;
  vm0UserId: string;
  orgId: string;
}): Promise<{ id: string }> {
  initServices();

  const [row] = await globalThis.services.db
    .insert(imessageUserLinks)
    .values({
      phoneHandle: normalizePhoneHandle(params.phoneHandle),
      vm0UserId: params.vm0UserId,
      orgId: params.orgId,
    })
    .returning({ id: imessageUserLinks.id });
  return row!;
}

/**
 * @why-db-direct Creates per-user iMessage routing preference rows for command
 * and run-routing tests.
 */
export async function seedTestIMessageUserAgentPreference(params: {
  vm0UserId: string;
  orgId: string;
  selectedComposeId: string | null;
}): Promise<void> {
  initServices();

  await globalThis.services.db
    .insert(imessageUserAgentPreferences)
    .values(params)
    .onConflictDoUpdate({
      target: [
        imessageUserAgentPreferences.vm0UserId,
        imessageUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: params.selectedComposeId,
        updatedAt: new Date(),
      },
    });
}

/**
 * @why-db-direct Creates session mappings for callback session persistence tests.
 */
export async function createIMessageThreadSession(params: {
  imessageUserLinkId: string;
  conversationId?: string | null;
  rootMessageId?: string;
  agentSessionId: string;
  lastProcessedMessageId?: string | null;
}): Promise<void> {
  initServices();

  await globalThis.services.db.insert(imessageThreadSessions).values({
    imessageUserLinkId: params.imessageUserLinkId,
    conversationId: params.conversationId ?? null,
    rootMessageId: params.rootMessageId ?? "dm",
    agentSessionId: params.agentSessionId,
    lastProcessedMessageId: params.lastProcessedMessageId ?? null,
  });
}

/**
 * @why-db-direct Inserts iMessage message context rows for focused context tests.
 */
export async function insertTestIMessageMessage(params: {
  agentphoneMessageId: string;
  agentphoneAgentId?: string;
  imessageUserLinkId?: string | null;
  phoneHandle: string;
  fromNumber: string;
  toNumber: string;
  direction: "inbound" | "outbound";
  body?: string | null;
  isBot?: boolean;
  createdAt?: Date;
}): Promise<void> {
  initServices();

  await globalThis.services.db.insert(imessageMessages).values({
    agentphoneMessageId: params.agentphoneMessageId,
    agentphoneAgentId: params.agentphoneAgentId ?? "agt-test",
    imessageUserLinkId: params.imessageUserLinkId ?? null,
    phoneHandle: normalizePhoneHandle(params.phoneHandle),
    fromNumber: normalizePhoneHandle(params.fromNumber),
    toNumber: normalizePhoneHandle(params.toNumber),
    direction: params.direction,
    channel: "imessage",
    body: params.body ?? null,
    isBot: params.isBot ?? params.direction === "outbound",
    createdAt: params.createdAt ?? new Date(),
  });
}

export function signTestIMessageConnectParams(
  phoneHandle: string,
  agentphoneAgentId: string,
  secret: string,
): { sig: string; ts: number } {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signIMessageConnectParams(
    normalizePhoneHandle(phoneHandle),
    agentphoneAgentId,
    ts,
    secret,
  );
  return { sig, ts };
}
