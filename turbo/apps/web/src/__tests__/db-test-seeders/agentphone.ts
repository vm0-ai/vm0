import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserAgentPreferences } from "@vm0/db/schema/agentphone-user-agent-preference";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { signAgentPhoneConnectParams } from "../../lib/zero/agentphone/connect-token";
import { normalizePhoneHandle } from "../../lib/zero/agentphone/shared";

/**
 * @why-db-direct Creates official shared AgentPhone user link rows for inbound
 * webhook and callback tests; no public test API exists for this provider state.
 */
export async function insertTestAgentPhoneUserLink(params: {
  phoneHandle: string;
  vm0UserId: string;
  orgId: string;
}): Promise<{ id: string }> {
  initServices();

  const [row] = await globalThis.services.db
    .insert(agentphoneUserLinks)
    .values({
      phoneHandle: normalizePhoneHandle(params.phoneHandle),
      vm0UserId: params.vm0UserId,
      orgId: params.orgId,
    })
    .returning({ id: agentphoneUserLinks.id });
  return row!;
}

/**
 * @why-db-direct Removes AgentPhone link state to exercise disconnect and stale
 * callback scenarios; no public test API exposes link deletion by id.
 */
export async function deleteTestAgentPhoneUserLinkById(id: string) {
  initServices();

  await globalThis.services.db
    .delete(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.id, id));
}

/**
 * @why-db-direct Creates per-user AgentPhone routing preference rows for command
 * and run-routing tests.
 */
export async function seedTestAgentPhoneUserAgentPreference(params: {
  vm0UserId: string;
  orgId: string;
  selectedComposeId: string | null;
}): Promise<void> {
  initServices();

  await globalThis.services.db
    .insert(agentphoneUserAgentPreferences)
    .values(params)
    .onConflictDoUpdate({
      target: [
        agentphoneUserAgentPreferences.vm0UserId,
        agentphoneUserAgentPreferences.orgId,
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
export async function createAgentPhoneThreadSession(params: {
  agentphoneUserLinkId: string;
  conversationId?: string | null;
  rootMessageId?: string;
  agentSessionId: string;
  lastProcessedMessageId?: string | null;
}): Promise<void> {
  initServices();

  await globalThis.services.db.insert(agentphoneThreadSessions).values({
    agentphoneUserLinkId: params.agentphoneUserLinkId,
    conversationId: params.conversationId ?? null,
    rootMessageId: params.rootMessageId ?? "dm",
    agentSessionId: params.agentSessionId,
    lastProcessedMessageId: params.lastProcessedMessageId ?? null,
  });
}

/**
 * @why-db-direct Inserts AgentPhone message context rows for focused context tests.
 */
export async function insertTestAgentPhoneMessage(params: {
  agentphoneMessageId: string;
  agentphoneAgentId?: string;
  agentphoneUserLinkId?: string | null;
  phoneHandle: string;
  fromNumber: string;
  toNumber: string;
  direction: "inbound" | "outbound";
  body?: string | null;
  mediaUrl?: string | null;
  channel?: string;
  isBot?: boolean;
  createdAt?: Date;
}): Promise<void> {
  initServices();

  await globalThis.services.db.insert(agentphoneMessages).values({
    agentphoneMessageId: params.agentphoneMessageId,
    agentphoneAgentId: params.agentphoneAgentId ?? "agt-test",
    agentphoneUserLinkId: params.agentphoneUserLinkId ?? null,
    phoneHandle: normalizePhoneHandle(params.phoneHandle),
    fromNumber: normalizePhoneHandle(params.fromNumber),
    toNumber: normalizePhoneHandle(params.toNumber),
    direction: params.direction,
    channel: params.channel ?? "sms",
    body: params.body ?? null,
    mediaUrl: params.mediaUrl ?? null,
    isBot: params.isBot ?? params.direction === "outbound",
    createdAt: params.createdAt ?? new Date(),
  });
}

export function signTestAgentPhoneConnectParams(
  phoneHandle: string,
  agentphoneAgentId: string,
  secret: string,
): { sig: string; ts: number } {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signAgentPhoneConnectParams(
    normalizePhoneHandle(phoneHandle),
    agentphoneAgentId,
    ts,
    secret,
  );
  return { sig, ts };
}
