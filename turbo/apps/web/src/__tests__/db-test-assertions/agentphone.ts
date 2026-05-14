import { and, eq, sql } from "drizzle-orm";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserAgentPreferences } from "@vm0/db/schema/agentphone-user-agent-preference";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import {
  normalizeAgentPhoneHandle,
  type AgentPhoneChannel,
} from "../../lib/zero/agentphone/shared";

export async function countTestAgentPhoneMessages(
  phoneHandle: string,
  channel: AgentPhoneChannel = "sms",
): Promise<number> {
  const result = await globalThis.services.db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentphoneMessages)
    .where(
      eq(
        agentphoneMessages.phoneHandle,
        normalizeAgentPhoneHandle(phoneHandle, channel),
      ),
    );
  return result[0]!.count;
}

export async function findTestAgentPhoneUserLink(
  phoneHandle: string,
  channel: AgentPhoneChannel = "sms",
) {
  const [row] = await globalThis.services.db
    .select()
    .from(agentphoneUserLinks)
    .where(
      eq(
        agentphoneUserLinks.phoneHandle,
        normalizeAgentPhoneHandle(phoneHandle, channel),
      ),
    )
    .limit(1);
  return row;
}

export async function findTestAgentPhoneUserLinksByVm0UserId(
  vm0UserId: string,
) {
  return globalThis.services.db
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.vm0UserId, vm0UserId));
}

export async function findTestAgentPhoneUserAgentPreference(params: {
  vm0UserId: string;
  orgId: string;
}) {
  const [row] = await globalThis.services.db
    .select()
    .from(agentphoneUserAgentPreferences)
    .where(
      and(
        eq(agentphoneUserAgentPreferences.vm0UserId, params.vm0UserId),
        eq(agentphoneUserAgentPreferences.orgId, params.orgId),
      ),
    )
    .limit(1);
  return row;
}

export async function agentphoneThreadSessionExists(params: {
  agentphoneUserLinkId: string;
  rootMessageId?: string;
}): Promise<boolean> {
  const [row] = await globalThis.services.db
    .select({ id: agentphoneThreadSessions.id })
    .from(agentphoneThreadSessions)
    .where(
      and(
        eq(
          agentphoneThreadSessions.agentphoneUserLinkId,
          params.agentphoneUserLinkId,
        ),
        eq(
          agentphoneThreadSessions.rootMessageId,
          params.rootMessageId ?? "dm",
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function findTestAgentPhoneThreadSession(params: {
  agentphoneUserLinkId: string;
  rootMessageId?: string;
}) {
  const [row] = await globalThis.services.db
    .select()
    .from(agentphoneThreadSessions)
    .where(
      and(
        eq(
          agentphoneThreadSessions.agentphoneUserLinkId,
          params.agentphoneUserLinkId,
        ),
        eq(
          agentphoneThreadSessions.rootMessageId,
          params.rootMessageId ?? "dm",
        ),
      ),
    )
    .limit(1);
  return row;
}
