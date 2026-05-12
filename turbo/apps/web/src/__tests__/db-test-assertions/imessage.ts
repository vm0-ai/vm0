import { and, eq, sql } from "drizzle-orm";
import { imessageMessages } from "@vm0/db/schema/imessage-message";
import { imessageThreadSessions } from "@vm0/db/schema/imessage-thread-session";
import { imessageUserAgentPreferences } from "@vm0/db/schema/imessage-user-agent-preference";
import { imessageUserLinks } from "@vm0/db/schema/imessage-user-link";
import { normalizePhoneHandle } from "../../lib/zero/imessage/shared";

export async function countTestIMessageMessages(
  phoneHandle: string,
): Promise<number> {
  const result = await globalThis.services.db
    .select({ count: sql<number>`count(*)::int` })
    .from(imessageMessages)
    .where(eq(imessageMessages.phoneHandle, normalizePhoneHandle(phoneHandle)));
  return result[0]!.count;
}

export async function findTestIMessageUserLink(phoneHandle: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(imessageUserLinks)
    .where(eq(imessageUserLinks.phoneHandle, normalizePhoneHandle(phoneHandle)))
    .limit(1);
  return row;
}

export async function findTestIMessageUserLinksByVm0UserId(vm0UserId: string) {
  return globalThis.services.db
    .select()
    .from(imessageUserLinks)
    .where(eq(imessageUserLinks.vm0UserId, vm0UserId));
}

export async function findTestIMessageUserAgentPreference(params: {
  vm0UserId: string;
  orgId: string;
}) {
  const [row] = await globalThis.services.db
    .select()
    .from(imessageUserAgentPreferences)
    .where(
      and(
        eq(imessageUserAgentPreferences.vm0UserId, params.vm0UserId),
        eq(imessageUserAgentPreferences.orgId, params.orgId),
      ),
    )
    .limit(1);
  return row;
}

export async function imessageThreadSessionExists(params: {
  imessageUserLinkId: string;
  rootMessageId?: string;
}): Promise<boolean> {
  const [row] = await globalThis.services.db
    .select({ id: imessageThreadSessions.id })
    .from(imessageThreadSessions)
    .where(
      and(
        eq(
          imessageThreadSessions.imessageUserLinkId,
          params.imessageUserLinkId,
        ),
        eq(imessageThreadSessions.rootMessageId, params.rootMessageId ?? "dm"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function findTestIMessageThreadSession(params: {
  imessageUserLinkId: string;
  rootMessageId?: string;
}) {
  const [row] = await globalThis.services.db
    .select()
    .from(imessageThreadSessions)
    .where(
      and(
        eq(
          imessageThreadSessions.imessageUserLinkId,
          params.imessageUserLinkId,
        ),
        eq(imessageThreadSessions.rootMessageId, params.rootMessageId ?? "dm"),
      ),
    )
    .limit(1);
  return row;
}
